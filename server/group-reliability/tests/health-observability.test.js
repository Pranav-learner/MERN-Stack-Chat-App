/**
 * Health monitoring + observability + monitor/alerts (Layer 10, Sprint 3): health scoring, group-health
 * aggregate, stall sweep, metrics, Prometheus, alert thresholds. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, seedOperation, countEvents } from "./helpers.js";
import { HealthStatus, ReliabilityState, RecoveryTrigger, ReliabilityEventType, AlertType, Metric } from "../types/types.js";
import { scoreHealth, scoreGroupHealth, GroupHealthMonitor } from "../health/healthMonitor.js";
import { GroupMetrics } from "../monitoring/metrics.js";
import { GroupMonitor } from "../monitoring/groupMonitor.js";
import { GroupReliabilityEventBus } from "../events/events.js";

describe("health scoring (pure)", () => {
  it("scores a healthy operation high + a failing one low", () => {
    const now = 1_700_000_050_000;
    const healthy = scoreHealth({ registeredAt: new Date(now - 5000).toISOString(), lastActivityAt: new Date(now - 500).toISOString(), checkpoint: { totalTargets: 40, completedTargets: 38, failedTargets: 1, pendingTargets: 1 } }, { now });
    assert.equal(healthy.status, HealthStatus.HEALTHY);
    const failing = scoreHealth({ registeredAt: new Date(now - 5000).toISOString(), lastActivityAt: new Date(now - 500).toISOString(), checkpoint: { totalTargets: 40, completedTargets: 5, failedTargets: 20, pendingTargets: 15 } }, { now });
    assert.ok(failing.score < healthy.score);
    assert.ok(failing.failureRate > 0.5);
  });

  it("freshness decays with staleness", () => {
    const now = 1_700_000_100_000;
    const fresh = scoreHealth({ registeredAt: new Date(now - 1000).toISOString(), lastActivityAt: new Date(now - 100).toISOString(), checkpoint: { totalTargets: 10, completedTargets: 5 } }, { now });
    const stale = scoreHealth({ registeredAt: new Date(now - 1000).toISOString(), lastActivityAt: new Date(now - 90_000).toISOString(), checkpoint: { totalTargets: 10, completedTargets: 5 } }, { now });
    assert.ok(fresh.score > stale.score);
  });

  it("aggregates group health across operations + per type", () => {
    const now = 1_700_000_050_000;
    const records = [
      { operationType: "fan-out", state: "tracking", registeredAt: new Date(now - 3000).toISOString(), lastActivityAt: new Date(now - 200).toISOString(), checkpoint: { totalTargets: 40, completedTargets: 40, pendingTargets: 0 } },
      { operationType: "rekey", state: "interrupted", registeredAt: new Date(now - 3000).toISOString(), lastActivityAt: new Date(now - 200).toISOString(), checkpoint: { totalTargets: 3, completedTargets: 1, failedTargets: 2, pendingTargets: 2 } },
    ];
    const gh = scoreGroupHealth(records, { now });
    assert.equal(gh.operations, 2);
    assert.equal(gh.interrupted, 1);
    assert.ok(gh.perType["fan-out"]);
    assert.ok(gh.perType["rekey"]);
    assert.ok([HealthStatus.DEGRADED, HealthStatus.UNHEALTHY].includes(gh.status));
  });
});

describe("health through the manager", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("degrades then recovers as failures rise + fall", async () => {
    await seedOperation(ctx.manager, { totalTargets: 40 });
    await ctx.manager.checkpoint({ operationId: "op:1", completedTargets: 5, cursor: 5, failedTargets: 20, pendingTargets: 35 });
    let rec = await ctx.manager.getRecord("op:1");
    assert.equal(rec.state, ReliabilityState.DEGRADED);
    assert.ok(countEvents(ctx.captured, ReliabilityEventType.HEALTH_CHANGED) >= 1);
    await ctx.manager.checkpoint({ operationId: "op:1", completedTargets: 39, cursor: 39, failedTargets: 0, pendingTargets: 1 });
    rec = await ctx.manager.getRecord("op:1");
    assert.equal(rec.state, ReliabilityState.TRACKING, "health recovered → back to tracking");
  });

  it("aggregates group health across operations", async () => {
    await seedOperation(ctx.manager, { operationId: "op:a", operationType: "fan-out", totalTargets: 10 });
    await seedOperation(ctx.manager, { operationId: "op:b", operationType: "rekey", totalTargets: 3 });
    const gh = await ctx.manager.getGroupHealth("g1");
    assert.equal(gh.operations, 2);
    assert.equal(gh.groupId, "g1");
  });
});

describe("stall monitor", () => {
  it("flags stalled operations as interrupted on sweep", async () => {
    const ctx = makeManager({ stallTimeoutMs: 30_000 });
    await seedOperation(ctx.manager);
    const monitor = new GroupHealthMonitor({ manager: ctx.manager, stallTimeoutMs: 30_000 });
    ctx.clock.advance(40_000); // no progress for 40s
    const { interrupted } = await monitor.sweep(ctx.clock.now());
    assert.equal(interrupted, 1);
    assert.equal((await ctx.manager.getRecord("op:1")).state, ReliabilityState.INTERRUPTED);
    assert.equal(monitor.stats().interrupted, 1);
  });
});

describe("metrics + observability", () => {
  it("records counters, histograms, gauges, and renders Prometheus", () => {
    const m = new GroupMetrics({ clock: () => 0 });
    m.recordOperation(true);
    m.recordMessage({ groupId: "g1", targets: 40, latencyMs: 12 });
    m.recordRecovery(true, 100);
    m.recordKeyRotation();
    m.gauge(Metric.HEALTH_SCORE, 0.9);
    const snap = m.snapshot();
    assert.equal(snap.counters[Metric.OPERATION_SUCCESS], 1);
    assert.equal(snap.counters[Metric.KEY_ROTATION_TOTAL], 1);
    assert.equal(snap.operationSuccessRate, 1);
    const prom = m.prometheus();
    assert.ok(prom.includes(Metric.FANOUT_LATENCY));
    assert.ok(prom.includes(Metric.HEALTH_SCORE));
  });

  it("registers an exporter (OTel/Prometheus hook)", () => {
    const m = new GroupMetrics();
    let exported = null;
    m.registerExporter((snap) => (exported = snap));
    m.recordOperation(false);
    m.exportMetrics();
    assert.ok(exported);
    assert.equal(exported.counters[Metric.OPERATION_FAILURE], 1);
  });

  it("manager surfaces metrics through the api + observability reads", async () => {
    const ctx = makeManager();
    await seedOperation(ctx.manager, { operationType: "group-message", totalTargets: 5 });
    await ctx.manager.checkpoint({ operationId: "op:1", completedTargets: 5, cursor: 5, pendingTargets: 0 });
    await ctx.manager.complete("op:1");
    const snap = ctx.api.metrics();
    // messages-per-group is recorded with a { group } label, so the snapshot key is labeled.
    assert.ok(Object.keys(snap.counters).some((k) => k.startsWith(Metric.MESSAGES_PER_GROUP)));
    const health = await ctx.api.health();
    assert.equal(health.framework, "group-reliability");
    assert.ok(ctx.api.prometheus().length > 0);
  });
});

describe("monitor + alerts", () => {
  it("raises an alert when operation failures spike past the threshold", () => {
    const events = new GroupReliabilityEventBus();
    const monitor = new GroupMonitor({ events, thresholds: { [AlertType.OPERATION_FAILURE_SPIKE]: 3 }, windowMs: 60_000, clock: () => 1000 });
    for (let i = 0; i < 3; i++) events.emit(ReliabilityEventType.OPERATION_FAILED, { operationId: `op:${i}`, groupId: "g" });
    const alerts = monitor.recentAlerts();
    assert.ok(alerts.some((a) => a.type === AlertType.OPERATION_FAILURE_SPIKE));
  });

  it("raises a stall alert on repeated interruptions", () => {
    const events = new GroupReliabilityEventBus();
    const monitor = new GroupMonitor({ events, thresholds: { [AlertType.STALL_TIMEOUT]: 2 }, clock: () => 1000 });
    events.emit(ReliabilityEventType.OPERATION_INTERRUPTED, { operationId: "op:1", trigger: RecoveryTrigger.STALL_TIMEOUT });
    events.emit(ReliabilityEventType.OPERATION_INTERRUPTED, { operationId: "op:2", trigger: RecoveryTrigger.STALL_TIMEOUT });
    assert.ok(monitor.recentAlerts().some((a) => a.type === AlertType.STALL_TIMEOUT));
  });
});

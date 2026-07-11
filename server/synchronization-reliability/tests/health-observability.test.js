/**
 * Health monitoring + observability (Layer 9, Sprint 3): health scoring, replica drift, the stall
 * sweep, the metrics registry, and the alerting monitor. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, seedSync, makeClock } from "./helpers.js";
import { scoreHealth, SyncHealthMonitor } from "../health/healthMonitor.js";
import { SyncMetrics } from "../monitoring/metrics.js";
import { SyncMonitor } from "../monitoring/syncMonitor.js";
import { ReliabilityEventBus } from "../events/events.js";
import { HealthStatus, ReliabilityState, ReliabilityEventType, AlertType, Metric } from "../types/types.js";

describe("health scoring (pure)", () => {
  const base = { registeredAt: new Date(1000).toISOString(), lastActivityAt: new Date(1000).toISOString(), checkpoint: { totalOperations: 100, completedOperations: 90, conflicts: 2, merges: 10, pendingOperations: 10, replicaDrift: 10 } };

  it("scores a fresh, progressing sync as healthy", () => {
    const h = scoreHealth(base, { now: 2000 });
    assert.equal(h.status, HealthStatus.HEALTHY);
    assert.ok(h.score >= 0.7);
    assert.equal(h.progress, 0.9);
  });

  it("degrades on staleness + drift", () => {
    const stale = scoreHealth(base, { now: 1000 + 70_000 });
    assert.ok(stale.score < scoreHealth(base, { now: 2000 }).score);
    const drifted = scoreHealth({ ...base, checkpoint: { ...base.checkpoint, replicaDrift: 900, completedOperations: 10 } }, { now: 2000 });
    assert.notEqual(drifted.status, HealthStatus.HEALTHY);
  });

  it("penalizes a high conflict rate", () => {
    const noisy = { ...base, checkpoint: { ...base.checkpoint, conflicts: 90, completedOperations: 100 } };
    assert.ok(scoreHealth(noisy, { now: 2000 }).conflictRate >= 0.5);
    assert.ok(scoreHealth(noisy, { now: 2000 }).score < scoreHealth(base, { now: 2000 }).score);
  });
});

describe("stall sweep", () => {
  it("flags a stalled sync as interrupted", async () => {
    const ctx = makeManager({ stallTimeoutMs: 45_000 });
    const id = await seedSync(ctx.manager);
    const monitor = new SyncHealthMonitor({ manager: ctx.manager, stallTimeoutMs: 45_000 });
    ctx.clock.advance(50_000);
    const res = await monitor.sweep(ctx.clock.now());
    assert.equal(res.interrupted, 1);
    assert.equal((await ctx.manager.getRecord(id)).state, ReliabilityState.INTERRUPTED);
    monitor.start();
    assert.equal(monitor.isRunning, true);
    monitor.stop();
  });
});

describe("metrics registry", () => {
  let m;
  beforeEach(() => {
    m = new SyncMetrics({ clock: makeClock().now });
  });

  it("records sync success rate + recovery + resume + conflicts", () => {
    m.recordSync(true, 120);
    m.recordSync(false, 300);
    assert.equal(m.syncSuccessRate(), 0.5);
    m.recordRecovery(true, 500);
    m.recordRecovery(false, 900);
    assert.equal(m.recoverySuccessRate(), 0.5);
    m.recordResume();
    m.recordConflictsMerges(3, 5);
    const snap = m.snapshot();
    assert.equal(snap.counters[Metric.RESUME_TOTAL], 1);
    assert.equal(snap.counters[Metric.CONFLICT_TOTAL], 3);
    assert.equal(snap.counters[Metric.MERGE_SUCCESS], 5);
  });

  it("renders Prometheus + fires an exporter + records gauges", () => {
    m.recordSync(true, 100);
    m.recordProgress({ throughput: 10, replicaDrift: 5, pendingOperations: 3, queueDepth: 3 });
    const text = m.prometheus();
    assert.match(text, /sync_success_total/);
    assert.match(text, /# TYPE sync_replica_drift gauge/);
    let exported = null;
    const off = m.registerExporter((snap) => (exported = snap));
    m.exportMetrics();
    assert.ok(exported.counters);
    off();
  });
});

describe("sync monitor alerts", () => {
  it("raises an alert when a signal crosses its threshold", () => {
    const bus = new ReliabilityEventBus();
    const metrics = new SyncMetrics({ clock: makeClock().now });
    const monitor = new SyncMonitor({ events: bus, metrics, thresholds: { [AlertType.SYNC_FAILURE_SPIKE]: 2 }, clock: makeClock().now });
    bus.emit(ReliabilityEventType.SYNC_FAILED, { syncId: "a" });
    assert.equal(monitor.recentAlerts().length, 0);
    bus.emit(ReliabilityEventType.SYNC_FAILED, { syncId: "b" });
    assert.equal(monitor.recentAlerts()[0].type, AlertType.SYNC_FAILURE_SPIKE);
  });

  it("raises on high replica drift + persists to a sink", () => {
    const bus = new ReliabilityEventBus();
    const recorded = [];
    const monitor = new SyncMonitor({ events: bus, sink: { record: (a) => recorded.push(a) }, thresholds: { [AlertType.HIGH_REPLICA_DRIFT]: 1 } });
    bus.emit(ReliabilityEventType.DRIFT_DETECTED, { syncId: "x", drift: 5000 });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].type, AlertType.HIGH_REPLICA_DRIFT);
    monitor.dispose();
  });
});

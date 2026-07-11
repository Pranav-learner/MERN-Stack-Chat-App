/**
 * Health monitoring + observability (Layer 8, Sprint 3): health scoring, the stall sweep, the metrics
 * registry (throughput/success/retry/resume/Prometheus/exporter), and the alerting monitor. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, seedTransfer, makeClock } from "./helpers.js";
import { scoreHealth, TransferHealthMonitor } from "../monitoring/healthMonitor.js";
import { TransferMetrics } from "../monitoring/metrics.js";
import { TransportMonitor } from "../monitoring/transportMonitor.js";
import { ReliabilityEventBus } from "../events/events.js";
import { HealthStatus, ReliabilityState, ReliabilityEventType, AlertType, Metric } from "../types/types.js";

describe("health scoring (pure)", () => {
  const base = { registeredAt: new Date(1000).toISOString(), lastActivityAt: new Date(1000).toISOString(), checkpoint: { totalChunks: 100, chunksAcked: 90, bytesTransferred: 5_000_000, retryCount: 2, outstanding: 4 } };

  it("scores a fresh, progressing transfer as healthy", () => {
    const h = scoreHealth(base, { now: 2000 });
    assert.equal(h.status, HealthStatus.HEALTHY);
    assert.ok(h.score >= 0.7);
    assert.equal(h.progress, 0.9);
  });

  it("degrades on staleness (lower score, and unhealthy when little progress)", () => {
    const stale = scoreHealth(base, { now: 1000 + 40_000 });
    const fresh = scoreHealth(base, { now: 2000 });
    assert.ok(stale.score < fresh.score, "staleness reduces the score");
    assert.ok(stale.stalenessMs >= 30_000);
    // An early, stalled transfer IS unhealthy (little progress cushion).
    const early = { registeredAt: new Date(1000).toISOString(), lastActivityAt: new Date(1000).toISOString(), checkpoint: { totalChunks: 100, chunksAcked: 3, bytesTransferred: 5000, retryCount: 1, outstanding: 2 } };
    assert.notEqual(scoreHealth(early, { now: 1000 + 40_000 }).status, HealthStatus.HEALTHY);
  });

  it("penalizes a high retry rate", () => {
    const noisy = { ...base, checkpoint: { ...base.checkpoint, retryCount: 200, chunksAcked: 100 } };
    const h = scoreHealth(noisy, { now: 2000 });
    assert.ok(h.retryRate >= 1);
    assert.ok(h.score < scoreHealth(base, { now: 2000 }).score);
  });
});

describe("stall sweep", () => {
  it("flags a stalled transfer as interrupted", async () => {
    const ctx = makeManager({ stallTimeoutMs: 20_000 });
    const id = await seedTransfer(ctx.manager);
    const monitor = new TransferHealthMonitor({ manager: ctx.manager, stallTimeoutMs: 20_000 });
    ctx.clock.advance(25_000); // no progress
    const res = await monitor.sweep(ctx.clock.now());
    assert.equal(res.interrupted, 1);
    assert.equal((await ctx.manager.getRecord(id)).state, ReliabilityState.INTERRUPTED);
  });

  it("does not flag a fresh transfer", async () => {
    const ctx = makeManager({ stallTimeoutMs: 20_000 });
    await seedTransfer(ctx.manager);
    const monitor = new TransferHealthMonitor({ manager: ctx.manager, stallTimeoutMs: 20_000 });
    const res = await monitor.sweep(ctx.clock.now());
    assert.equal(res.interrupted, 0);
    monitor.start();
    assert.equal(monitor.isRunning, true);
    monitor.stop();
  });
});

describe("metrics registry", () => {
  let m;
  beforeEach(() => {
    m = new TransferMetrics({ clock: makeClock().now });
  });

  it("records transfer success rate + recovery + resume + migration", () => {
    m.recordTransfer(true, 120);
    m.recordTransfer(false, 300);
    assert.equal(m.transferSuccessRate(), 0.5);
    m.recordRecovery(true, 500);
    m.recordRecovery(false, 900);
    assert.equal(m.recoverySuccessRate(), 0.5);
    m.recordResume();
    m.recordMigration(true);
    const snap = m.snapshot();
    assert.equal(snap.counters[Metric.RESUME_TOTAL], 1);
    assert.equal(snap.counters[Metric.MIGRATION_SUCCESS], 1);
  });

  it("renders Prometheus text + fires an exporter", () => {
    m.recordTransfer(true, 100);
    m.gauge(Metric.HEALTH_SCORE, 0.9);
    const text = m.prometheus();
    assert.match(text, /transport_transfer_success_total/);
    assert.match(text, /# TYPE transport_health_score gauge/);
    let exported = null;
    const off = m.registerExporter((snap) => (exported = snap));
    m.exportMetrics();
    assert.ok(exported.counters);
    off();
  });
});

describe("transport monitor alerts", () => {
  it("raises an alert when a signal crosses its threshold", () => {
    const bus = new ReliabilityEventBus();
    const metrics = new TransferMetrics({ clock: makeClock().now });
    const monitor = new TransportMonitor({ events: bus, metrics, thresholds: { [AlertType.TRANSFER_FAILURE_SPIKE]: 2 }, clock: makeClock().now });
    bus.emit(ReliabilityEventType.TRANSFER_FAILED, { transferId: "a" });
    assert.equal(monitor.recentAlerts().length, 0);
    bus.emit(ReliabilityEventType.TRANSFER_FAILED, { transferId: "b" });
    const alerts = monitor.recentAlerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, AlertType.TRANSFER_FAILURE_SPIKE);
    assert.equal(metrics.snapshot().counters[`${Metric.ALERT_TOTAL}{type="${AlertType.TRANSFER_FAILURE_SPIKE}"}`], 1);
  });

  it("persists alerts to an injected sink", () => {
    const bus = new ReliabilityEventBus();
    const recorded = [];
    const monitor = new TransportMonitor({ events: bus, sink: { record: (a) => recorded.push(a) }, thresholds: { [AlertType.STALL_TIMEOUT]: 1 } });
    bus.emit(ReliabilityEventType.TRANSFER_INTERRUPTED, { transferId: "x", trigger: "stall-timeout" });
    assert.equal(recorded.length, 1);
    monitor.dispose();
  });
});

/**
 * Health monitoring + observability + cache + monitor/alerts (Layer 11, Sprint 3). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, seedOperation, countEvents } from "./helpers.js";
import { HealthStatus, ReliabilityState, RecoveryTrigger, ReliabilityEventType, AlertType, Metric } from "../types/types.js";
import { scoreHealth, scoreMediaHealth, MediaHealthMonitor } from "../health/healthMonitor.js";
import { MediaMetrics } from "../monitoring/metrics.js";
import { MediaMonitor } from "../monitoring/mediaMonitor.js";
import { MediaCache } from "../cache/mediaCache.js";
import { MediaReliabilityEventBus } from "../events/events.js";

describe("health scoring (pure)", () => {
  it("scores a healthy transfer high + a failing one low", () => {
    const now = 1_700_000_050_000;
    const healthy = scoreHealth({ registeredAt: new Date(now - 5000).toISOString(), lastActivityAt: new Date(now - 500).toISOString(), checkpoint: { totalChunks: 40, completedChunks: 38, failedChunks: 1, pendingChunks: 1 } }, { now });
    assert.equal(healthy.status, HealthStatus.HEALTHY);
    const failing = scoreHealth({ registeredAt: new Date(now - 5000).toISOString(), lastActivityAt: new Date(now - 500).toISOString(), checkpoint: { totalChunks: 40, completedChunks: 5, failedChunks: 20, pendingChunks: 15 } }, { now });
    assert.ok(failing.score < healthy.score);
    assert.ok(failing.failureRate > 0.5);
  });

  it("aggregates media health per operation type", () => {
    const now = 1_700_000_050_000;
    const records = [
      { operationType: "upload", state: "tracking", registeredAt: new Date(now - 3000).toISOString(), lastActivityAt: new Date(now - 200).toISOString(), checkpoint: { totalChunks: 40, completedChunks: 40, pendingChunks: 0 } },
      { operationType: "download", state: "interrupted", registeredAt: new Date(now - 3000).toISOString(), lastActivityAt: new Date(now - 200).toISOString(), checkpoint: { totalChunks: 10, completedChunks: 1, failedChunks: 5, pendingChunks: 9 } },
    ];
    const mh = scoreMediaHealth(records, { now });
    assert.equal(mh.operations, 2);
    assert.equal(mh.interrupted, 1);
    assert.ok(mh.perType.upload && mh.perType.download);
    assert.ok([HealthStatus.DEGRADED, HealthStatus.UNHEALTHY].includes(mh.status));
  });
});

describe("health through the manager", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("degrades then recovers as failures rise + fall", async () => {
    await seedOperation(ctx.manager, { totalChunks: 40 });
    await ctx.manager.checkpoint({ operationId: "op:1", completedChunks: 5, cursor: 5, failedChunks: 20, pendingChunks: 35 });
    assert.equal((await ctx.manager.getRecord("op:1")).state, ReliabilityState.DEGRADED);
    await ctx.manager.checkpoint({ operationId: "op:1", completedChunks: 39, cursor: 39, failedChunks: 0, pendingChunks: 1 });
    assert.equal((await ctx.manager.getRecord("op:1")).state, ReliabilityState.TRACKING);
  });
});

describe("stall monitor", () => {
  it("flags stalled operations as interrupted on sweep", async () => {
    const ctx = makeManager({ stallTimeoutMs: 30_000 });
    await seedOperation(ctx.manager);
    const monitor = new MediaHealthMonitor({ manager: ctx.manager, stallTimeoutMs: 30_000 });
    ctx.clock.advance(40_000);
    const { interrupted } = await monitor.sweep(ctx.clock.now());
    assert.equal(interrupted, 1);
    assert.equal((await ctx.manager.getRecord("op:1")).state, ReliabilityState.INTERRUPTED);
  });
});

describe("metrics + observability", () => {
  it("records upload/download throughput + success rates + Prometheus", () => {
    const m = new MediaMetrics({ clock: () => 0 });
    m.recordUpload(true, 1000, 5_000_000);
    m.recordDownload(true, 500, 2_500_000);
    m.recordDownload(false);
    m.recordRecovery(true, 100);
    const snap = m.snapshot();
    assert.equal(snap.counters[Metric.UPLOAD_SUCCESS], 1);
    assert.equal(snap.uploadSuccessRate, 1);
    assert.equal(snap.downloadSuccessRate, 0.5);
    assert.equal(snap.counters[Metric.BYTES_TRANSFERRED], 7_500_000);
    const prom = m.prometheus();
    assert.ok(prom.includes(Metric.UPLOAD_THROUGHPUT));
    assert.ok(prom.includes(Metric.DOWNLOAD_TIME));
  });

  it("cache hit-rate feeds a first-class metric", async () => {
    const m = new MediaMetrics();
    const cache = new MediaCache({ metrics: m });
    await cache.set("a", { v: 1 });
    await cache.get("a"); // hit
    await cache.get("b"); // miss
    assert.equal(cache.stats().hitRate, 0.5);
    assert.equal(m.cacheHitRate(), 0.5);
    assert.equal(m.snapshot().cacheHitRate, 0.5);
  });

  it("cache TTL + LRU + read-through", async () => {
    let now = 0;
    const cache = new MediaCache({ clock: () => now, ttlMs: 100, max: 2 });
    await cache.set("a", 1);
    assert.equal(await cache.get("a"), 1);
    now = 200;
    assert.equal(await cache.get("a"), null, "expired");
    const loaded = await cache.getOrLoad("x", async () => 42);
    assert.equal(loaded, 42);
    assert.equal(await cache.get("x"), 42, "read-through cached it");
  });

  it("registers an exporter (OTel hook)", () => {
    const m = new MediaMetrics();
    let exported = null;
    m.registerExporter((snap) => (exported = snap));
    m.recordUpload(false);
    m.exportMetrics();
    assert.ok(exported);
    assert.equal(exported.counters[Metric.UPLOAD_FAILURE], 1);
  });

  it("manager surfaces media metrics through the api", async () => {
    const ctx = makeManager();
    await seedOperation(ctx.manager, { operationType: "upload", totalChunks: 4, bytesTotal: 1000 });
    await ctx.manager.checkpoint({ operationId: "op:1", completedChunks: 4, cursor: 4, pendingChunks: 0, bytesTransferred: 1000 });
    await ctx.manager.complete("op:1");
    const snap = ctx.api.metrics();
    assert.equal(snap.counters[Metric.UPLOAD_TOTAL], 1);
    const health = await ctx.api.health();
    assert.equal(health.framework, "media-reliability");
    assert.ok(ctx.api.prometheus().length > 0);
  });
});

describe("monitor + alerts", () => {
  function countEv(list, type) { return list.filter((e) => e.type === type).length; }

  it("raises an alert on operation-failure spike + storage-failure spike", () => {
    const events = new MediaReliabilityEventBus();
    const monitor = new MediaMonitor({ events, thresholds: { [AlertType.OPERATION_FAILURE_SPIKE]: 3, [AlertType.STORAGE_FAILURE_SPIKE]: 2 }, clock: () => 1000 });
    for (let i = 0; i < 3; i++) events.emit(ReliabilityEventType.OPERATION_FAILED, { operationId: `op:${i}`, mediaId: "m" });
    assert.ok(monitor.recentAlerts().some((a) => a.type === AlertType.OPERATION_FAILURE_SPIKE));
    events.emit(ReliabilityEventType.OPERATION_INTERRUPTED, { operationId: "op:a", trigger: RecoveryTrigger.STORAGE_FAILURE });
    events.emit(ReliabilityEventType.OPERATION_INTERRUPTED, { operationId: "op:b", trigger: RecoveryTrigger.STORAGE_FAILURE });
    assert.ok(monitor.recentAlerts().some((a) => a.type === AlertType.STORAGE_FAILURE_SPIKE));
  });
});

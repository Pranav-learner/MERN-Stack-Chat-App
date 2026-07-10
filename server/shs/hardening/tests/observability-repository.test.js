import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MetricsCollector, Metric } from "../observability/metrics.js";
import { Tracer } from "../observability/tracer.js";
import { HealthMonitor } from "../observability/healthMonitor.js";
import { hardenRepository, KeyedMutex } from "../repository/hardenedRepository.js";
import { ConcurrencyConflictError } from "../errors.js";
import { HealthStatus } from "../types.js";
import { HandshakeEventBus } from "../../events/events.js";
import { SessionEventBus } from "../../session/events/events.js";
import { createInMemorySessionRepository } from "../../session/repository/inMemoryRepository.js";

describe("MetricsCollector", () => {
  it("counters, gauges, histograms with percentiles", () => {
    const m = new MetricsCollector();
    m.increment(Metric.HANDSHAKES_STARTED);
    m.increment(Metric.HANDSHAKES_STARTED, 4);
    m.gauge(Metric.SESSIONS_ACTIVE, 7);
    for (let i = 1; i <= 100; i++) m.observe(Metric.HANDSHAKE_LATENCY_MS, i);
    const snap = m.snapshot();
    assert.equal(snap.counters[Metric.HANDSHAKES_STARTED], 5);
    assert.equal(snap.gauges[Metric.SESSIONS_ACTIVE], 7);
    assert.equal(snap.histograms[Metric.HANDSHAKE_LATENCY_MS].count, 100);
    assert.ok(snap.histograms[Metric.HANDSHAKE_LATENCY_MS].p95 >= 90);
  });

  it("time() records a duration", async () => {
    let t = 0;
    const clock = () => (t += 10);
    const m = new MetricsCollector();
    await m.time(Metric.VALIDATION_MS, async () => 1, clock);
    assert.equal(m.snapshot().histograms[Metric.VALIDATION_MS].count, 1);
  });
});

describe("Tracer", () => {
  it("records spans + durations when enabled; error status on throw", async () => {
    let t = 0;
    const tr = new Tracer({ enabled: true, clock: () => (t += 5) });
    await tr.trace("ok-op", async () => 1);
    await assert.rejects(() => tr.trace("bad-op", async () => { throw new Error("boom"); }));
    assert.equal(tr.spans.length, 2);
    assert.equal(tr.spans[0].status, "ok");
    assert.equal(tr.spans[1].status, "error");
    assert.ok(tr.spans[0].durationMs > 0);
  });

  it("is a no-op when disabled", async () => {
    const tr = new Tracer({ enabled: false });
    await tr.trace("op", async () => 1);
    assert.equal(tr.spans.length, 0);
  });
});

describe("HealthMonitor", () => {
  it("reports healthy/degraded/unhealthy from event-driven metrics", () => {
    const hb = new HandshakeEventBus();
    const sb = new SessionEventBus();
    const hm = new HealthMonitor().attach({ handshakes: hb, sessions: sb });

    hb.emit("handshake.started", {});
    hb.emit("handshake.completed", {});
    assert.equal(hm.health().status, HealthStatus.HEALTHY);

    for (let i = 0; i < 6; i++) {
      hb.emit("handshake.started", {});
      hb.emit("handshake.failed", {});
    }
    const h = hm.health();
    assert.ok([HealthStatus.DEGRADED, HealthStatus.UNHEALTHY].includes(h.status));
    assert.ok(h.failureRate > 0);
    hm.detach();
  });

  it("security signals degrade health", () => {
    const hb = new HandshakeEventBus();
    const hm = new HealthMonitor().attach({ handshakes: hb, hardening: hb });
    hb.emit("handshake.started", {});
    hb.emit("handshake.completed", {});
    hb.emit("hardening.replay_detected", {});
    assert.equal(hm.health().status, HealthStatus.DEGRADED);
    assert.equal(hm.health().signals.replaysDetected, 1);
  });
});

describe("hardened repository", () => {
  it("idempotent create + read cache + delete", async () => {
    const repo = hardenRepository(createInMemorySessionRepository().sessions, { idOf: (r) => r.sessionId, cacheTtlMs: 1000 });
    await repo.create({ sessionId: "s1", status: "active" });
    await assert.rejects(() => repo.create({ sessionId: "s1", status: "active" }), ConcurrencyConflictError);
    assert.equal((await repo.findById("s1")).status, "active");
    await repo.update("s1", { status: "closed" });
    assert.equal((await repo.findById("s1")).status, "closed"); // cache refreshed on write
    await repo.delete("s1");
    assert.equal(await repo.findById("s1"), null);
  });

  it("optimistic concurrency rejects stale writes", async () => {
    const repo = hardenRepository(createInMemorySessionRepository().sessions, { idOf: (r) => r.sessionId, optimistic: true });
    const created = await repo.create({ sessionId: "s1", status: "active" });
    assert.equal(created._rev, 0);
    const bumped = await repo.update("s1", { status: "idle", _rev: 0 });
    assert.equal(bumped._rev, 1);
    await assert.rejects(() => repo.update("s1", { status: "closed", _rev: 0 }), ConcurrencyConflictError); // stale
  });

  it("write validation runs before persisting", async () => {
    const repo = hardenRepository(createInMemorySessionRepository().sessions, {
      idOf: (r) => r.sessionId,
      validate: (r) => {
        if (!r.status) throw new Error("status required");
      },
    });
    await assert.rejects(() => repo.create({ sessionId: "s1" }), /status required/);
  });
});

describe("KeyedMutex — concurrency safety", () => {
  it("serializes same-key work (no lost updates) but parallelizes different keys", async () => {
    const mtx = new KeyedMutex();
    let counter = 0;
    const bump = () => mtx.run("k", async () => { const c = counter; await Promise.resolve(); counter = c + 1; });
    await Promise.all(Array.from({ length: 50 }, bump));
    assert.equal(counter, 50);
    assert.equal(mtx.size, 0); // drained

    const order = [];
    await Promise.all([
      mtx.run("a", async () => { order.push("a1"); await Promise.resolve(); order.push("a2"); }),
      mtx.run("b", async () => { order.push("b1"); await Promise.resolve(); order.push("b2"); }),
    ]);
    assert.equal(order.length, 4);
  });
});

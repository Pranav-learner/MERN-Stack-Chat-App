/**
 * Repository contract, concurrency, large-scale connection simulation, recovery/performance
 * benchmarks, failure injection, and fuzz tests (Layer 7, Sprint 3). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, makeClock, makeIdGen, noSleep } from "./helpers.js";
import { createInMemoryReliabilityRepository } from "../repository/inMemoryReliabilityRepository.js";
import {
  validateRegisterRequest,
  validateTrigger,
  validateRetryPolicy,
  assertNoSecretMaterial,
  validateConnection,
  requireConnection,
  FORBIDDEN_SECRET_KEYS,
} from "../validators/validators.js";
import { computeHealth } from "../health/healthMonitor.js";
import { nextDelay, shouldRetry } from "../retry/retryPolicy.js";
import { ConnectionState, RecoveryTrigger } from "../types/types.js";
import { ConnectionNotFoundError, ReliabilityError, ReliabilityValidationError } from "../errors.js";

// ---------------------------------------------------------------------------
describe("connection repository — contract", () => {
  let repo;
  beforeEach(() => {
    ({ connections: repo } = createInMemoryReliabilityRepository());
  });
  const conn = (over = {}) => ({ connectionId: "c-00000001", deviceId: "d1", peerId: "d2", state: ConnectionState.CONNECTED, establishedAt: "2026-01-01T00:00:00.000Z", ...over });

  it("create / findById / findByDeviceAndPeer / update / delete + deep-copy", async () => {
    await repo.create(conn());
    const got = await repo.findById("c-00000001");
    got.state = ConnectionState.FAILED; // mutate copy
    assert.equal((await repo.findById("c-00000001")).state, ConnectionState.CONNECTED);
    assert.equal((await repo.findByDeviceAndPeer("d1", "d2")).connectionId, "c-00000001");
    await repo.update("c-00000001", { state: ConnectionState.DEGRADED });
    assert.equal((await repo.findById("c-00000001")).state, ConnectionState.DEGRADED);
    await assert.rejects(() => repo.update("missing-00000000", {}), ConnectionNotFoundError);
    assert.equal(await repo.delete("c-00000001"), true);
  });

  it("listLive / listTimedOut / countByState", async () => {
    await repo.create(conn({ connectionId: "c-a", heartbeatExpiresAt: "2026-01-01T00:00:10.000Z" }));
    await repo.create(conn({ connectionId: "c-b", peerId: "d3", state: ConnectionState.FAILED }));
    assert.equal((await repo.listLive()).length, 1);
    assert.equal((await repo.listTimedOut("2026-01-01T00:00:20.000Z")).length, 1); // c-a timed out
    const counts = await repo.countByState();
    assert.equal(counts.connected, 1);
    assert.equal(counts.failed, 1);
  });
});

// ---------------------------------------------------------------------------
describe("recovery + alert history repositories", () => {
  it("recovery record/list; alert record/list/count", async () => {
    const { recovery, alerts } = createInMemoryReliabilityRepository();
    await recovery.record({ connectionId: "c1", trigger: "network-loss", recovered: true, at: "2026-01-01T00:00:00.000Z" });
    await recovery.record({ connectionId: "c1", trigger: "relay-failure", recovered: false, at: "2026-01-02T00:00:00.000Z" });
    const h = await recovery.listByConnection("c1");
    assert.equal(h.length, 2);
    assert.equal(h[0].trigger, "relay-failure"); // newest first
    await alerts.record({ alertId: "a1", alertType: "reconnect-storm", at: 1 });
    assert.equal(await alerts.count(), 1);
    assert.equal((await alerts.list()).length, 1);
  });
});

// ---------------------------------------------------------------------------
describe("validators", () => {
  it("register request / trigger / retry-policy guards", () => {
    assert.throws(() => validateRegisterRequest({ deviceId: "d1" }), ReliabilityValidationError); // no peerId
    assert.throws(() => validateRegisterRequest({ deviceId: "d1", peerId: "d2", state: "bogus" }), ReliabilityValidationError);
    assert.doesNotThrow(() => validateRegisterRequest({ deviceId: "d1", peerId: "d2", state: "connected" }));
    assert.throws(() => validateTrigger("nope"), ReliabilityValidationError);
    assert.throws(() => validateRetryPolicy({ maxAttempts: -1 }), ReliabilityValidationError);
  });

  it("connection validation + no-secret invariant", () => {
    assert.throws(() => requireConnection(null, "x"), ConnectionNotFoundError);
    assert.throws(() => validateConnection({ connectionId: "x" }), /corrupted|missing/i);
    for (const secret of FORBIDDEN_SECRET_KEYS) assert.throws(() => assertNoSecretMaterial({ [secret]: "leak" }), ReliabilityError);
    assert.throws(() => assertNoSecretMaterial({ a: [{ sessionKey: "x" }] }), ReliabilityError);
    // sessionId (an id) is NOT forbidden.
    assert.doesNotThrow(() => assertNoSecretMaterial({ sessionId: "s1" }));
  });
});

// ---------------------------------------------------------------------------
describe("concurrency + large-scale", () => {
  it("registers 500 connections + recovers a batch concurrently", async () => {
    const ctx = makeManager();
    const conns = await Promise.all(Array.from({ length: 500 }, (_, i) => ctx.manager.registerConnection({ deviceId: `d${i}`, peerId: "peer", sessionId: `s${i}`, state: ConnectionState.CONNECTED })));
    assert.equal(conns.length, 500);
    const recovered = await Promise.all(conns.slice(0, 100).map((c) => ctx.manager.recover(c.connectionId, RecoveryTrigger.UNEXPECTED_DISCONNECT)));
    assert.equal(recovered.filter((r) => r.recovery.recovered).length, 100);
  });

  it("recovery benchmark: 1000 recoveries under a generous budget", async () => {
    const ctx = makeManager({ retryPolicy: { maxAttempts: 3, baseDelayMs: 0, jitter: false } });
    const c = await ctx.manager.registerConnection({ deviceId: "d1", peerId: "d2", sessionId: "s1", state: ConnectionState.CONNECTED });
    const start = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) await ctx.manager.recover(c.connectionId, RecoveryTrigger.UNEXPECTED_DISCONNECT);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 3000, `1000 recoveries took ${ms}ms`);
    assert.ok((await ctx.manager.getConnection(c.connectionId)).recoveryCount >= 1000);
  });

  it("heartbeat sweep over 300 stale connections", async () => {
    const clock = makeClock();
    const ctx = makeManager({ clock });
    for (let i = 0; i < 300; i++) await ctx.manager.registerConnection({ deviceId: `d${i}`, peerId: "p", sessionId: `s${i}`, state: ConnectionState.CONNECTED });
    clock.advance(20_000);
    const res = await ctx.manager.sweepHeartbeats(clock());
    assert.equal(res.timedOut, 300);
    assert.equal(res.recovered, 300);
  });
});

// ---------------------------------------------------------------------------
describe("failure injection + FUZZ", () => {
  it("a throwing reconnect hook never crashes recovery (degrades to failed)", async () => {
    const ctx = makeManager();
    ctx.manager.recovery.hooks = { reconnect: async () => { throw new Error("boom"); }, resume: async () => { throw new Error("boom"); }, gracefulFail: async () => true };
    const c = await ctx.manager.registerConnection({ deviceId: "d1", peerId: "d2", sessionId: "s1", state: ConnectionState.CONNECTED });
    const out = await ctx.manager.recover(c.connectionId, RecoveryTrigger.UNEXPECTED_DISCONNECT, { retryPolicy: { maxAttempts: 2, baseDelayMs: 1, jitter: false } });
    assert.equal(out.recovery.recovered, false);
    assert.equal(out.connection.state, ConnectionState.FAILED);
  });

  /** Deterministic fuzz corpus (no Math.random). */
  function* corpus(n) {
    let s = 999;
    const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const junk = [null, undefined, 0, NaN, Infinity, "", "x".repeat(500), [], {}, true, { privateKey: "leak" }, { maxAttempts: -5 }, { latencyMs: "nope" }, { strategy: "??" }];
    for (let i = 0; i < n; i++) yield junk[Math.floor(rand() * junk.length)];
  }

  it("validators only ever throw typed ReliabilityErrors", () => {
    for (const input of corpus(400)) {
      try {
        validateRegisterRequest(input);
      } catch (e) {
        assert.ok(e instanceof ReliabilityError, `unexpected error: ${e}`);
      }
    }
  });

  it("computeHealth + retry math are total (never throw) on arbitrary input", () => {
    for (const input of corpus(400)) {
      const h = computeHealth(typeof input === "object" && input ? input : {});
      assert.ok(Number.isFinite(h.score) && h.score >= 0 && h.score <= 1);
      const d = nextDelay(1, typeof input === "object" && input ? input : {});
      assert.ok(Number.isFinite(d) && d >= 0);
      const r = shouldRetry(1, 0, typeof input === "object" && input ? input : {});
      assert.equal(typeof r.allowed, "boolean");
    }
  });

  it("assertNoSecretMaterial is cycle-safe", () => {
    const node = { connectionId: "c" };
    node.self = node;
    assert.doesNotThrow(() => assertNoSecretMaterial(node));
  });
});

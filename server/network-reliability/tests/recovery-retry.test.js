/**
 * Recovery (all triggers + WiFi↔mobile + NAT rebind + relay failure), retry policies, lifecycle FSM,
 * and health tests (Layer 7, Sprint 3). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, makeHooks, makeClock, noSleep, recordEvents } from "./helpers.js";
import { RecoveryCoordinator, RECOVERY_PLANS } from "../recovery/recoveryCoordinator.js";
import { resolveRetryPolicy, nextDelay, shouldRetry, RetryController } from "../retry/retryPolicy.js";
import {
  ConnectionLifecycle,
  ALLOWED_TRANSITIONS,
  canTransition,
  assertTransition,
} from "../manager/connectionLifecycle.js";
import { computeHealth, healthForConnection, scoreToStatus } from "../health/healthMonitor.js";
import { ReliabilityEventBus } from "../events/events.js";
import { ConnectionState, RecoveryTrigger, RecoveryAction, RetryStrategy, HealthStatus, ReliabilityEventType, ALL_RECOVERY_TRIGGERS } from "../types/types.js";
import { RecoveryFailedError } from "../errors.js";

// ---------------------------------------------------------------------------
describe("connection lifecycle state machine", () => {
  it("walks the recovery cycle connected→disconnected→reconnecting→connected", () => {
    assert.ok(canTransition(ConnectionState.CONNECTED, ConnectionState.DISCONNECTED));
    assert.ok(canTransition(ConnectionState.DISCONNECTED, ConnectionState.RECONNECTING));
    assert.ok(canTransition(ConnectionState.RECONNECTING, ConnectionState.CONNECTED));
    assert.ok(canTransition(ConnectionState.CONNECTED, ConnectionState.DEGRADED));
    assert.ok(canTransition(ConnectionState.DEGRADED, ConnectionState.CONNECTED));
  });

  it("rejects illegal jumps; every state mapped; CLOSED terminal", () => {
    assert.ok(!canTransition(ConnectionState.NEW, ConnectionState.DEGRADED));
    assert.throws(() => assertTransition(ConnectionState.CLOSED, ConnectionState.CONNECTED), /Cannot transition/);
    for (const s of Object.values(ConnectionState)) assert.ok(s in ALLOWED_TRANSITIONS);
    assert.deepEqual(ALLOWED_TRANSITIONS[ConnectionState.CLOSED], []);
  });

  it("driver records history", () => {
    const fsm = new ConnectionLifecycle(ConnectionState.CONNECTED, { clock: makeClock() });
    fsm.transition(ConnectionState.DISCONNECTED);
    fsm.transition(ConnectionState.RECONNECTING, { reason: "drop" });
    fsm.transition(ConnectionState.CONNECTED);
    assert.equal(fsm.state, ConnectionState.CONNECTED);
    assert.equal(fsm.history.length, 3);
  });
});

// ---------------------------------------------------------------------------
describe("retry policies", () => {
  it("exponential backoff grows + caps; fixed + immediate", () => {
    const p = { strategy: RetryStrategy.EXPONENTIAL_BACKOFF, baseDelayMs: 100, factor: 2, maxDelayMs: 500, jitter: false };
    assert.deepEqual([1, 2, 3, 4].map((a) => nextDelay(a, p)), [100, 200, 400, 500]);
    assert.equal(nextDelay(3, { strategy: RetryStrategy.FIXED, baseDelayMs: 50, jitter: false }), 50);
    assert.equal(nextDelay(3, { strategy: RetryStrategy.IMMEDIATE }), 0);
  });

  it("shouldRetry respects max attempts, recovery timeout, and NONE", () => {
    assert.equal(shouldRetry(6, 0, { maxAttempts: 5 }).allowed, false);
    assert.equal(shouldRetry(2, 99999, { maxAttempts: 5, recoveryTimeoutMs: 1000 }).reason, "recovery-timeout");
    assert.equal(shouldRetry(1, 0, { strategy: RetryStrategy.NONE }).allowed, false);
    assert.equal(shouldRetry(2, 0, { maxAttempts: 5 }).allowed, true);
  });

  it("RetryController drives a bounded loop with an injected sleep", async () => {
    const clock = makeClock();
    const ctrl = new RetryController({ maxAttempts: 3, baseDelayMs: 10, jitter: false, recoveryTimeoutMs: 1e9 }, { clock, sleep: noSleep });
    const attempts = [];
    let d;
    while ((d = await ctrl.next()).proceed) attempts.push(d.attempt);
    assert.deepEqual(attempts, [1, 2, 3]);
    assert.equal((await ctrl.next()).reason, "max-attempts");
  });

  it("resolveRetryPolicy merges defaults", () => {
    assert.equal(resolveRetryPolicy({ maxAttempts: 9 }).maxAttempts, 9);
    assert.equal(resolveRetryPolicy().strategy, RetryStrategy.EXPONENTIAL_BACKOFF);
  });
});

// ---------------------------------------------------------------------------
describe("recovery coordinator", () => {
  it("has a plan for every trigger", () => {
    for (const t of ALL_RECOVERY_TRIGGERS) assert.ok(RECOVERY_PLANS[t], `missing plan for ${t}`);
  });

  it("network-loss resumes the session without a reconnect", async () => {
    const h = makeHooks({ resume: true });
    const rc = new RecoveryCoordinator({ hooks: h.hooks, sleep: noSleep });
    const out = await rc.recover(RecoveryTrigger.NETWORK_LOSS, { connectionId: "c1", sessionId: "s1" });
    assert.equal(out.recovered, true);
    assert.equal(out.action, RecoveryAction.RESUME_SESSION);
    assert.ok(h.ran.includes("resume") && !h.ran.includes("reconnect"));
    assert.equal(out.sessionPreserved, true);
  });

  it("resume failure falls through to a bounded reconnect", async () => {
    const h = makeHooks({ resume: false, succeedAfter: 2 });
    const rc = new RecoveryCoordinator({ hooks: h.hooks, sleep: noSleep, retryPolicy: { maxAttempts: 5, baseDelayMs: 1, jitter: false } });
    const out = await rc.recover(RecoveryTrigger.NETWORK_LOSS, { connectionId: "c1", sessionId: "s1" });
    assert.equal(out.recovered, true);
    assert.equal(out.attempts, 2);
  });

  it("wifi-to-mobile refreshes candidates then reconnects", async () => {
    const h = makeHooks();
    const rc = new RecoveryCoordinator({ hooks: h.hooks, sleep: noSleep });
    const out = await rc.recover(RecoveryTrigger.WIFI_TO_MOBILE, { connectionId: "c1", sessionId: "s1" });
    assert.equal(out.action, RecoveryAction.REFRESH_CANDIDATES);
    assert.ok(h.ran.includes("refreshCandidates") && h.ran.includes("reconnect"));
  });

  it("relay-failure switches relay + emits failover", async () => {
    const events = new ReliabilityEventBus();
    const seen = [];
    events.on("*", (e) => seen.push(e.type));
    const h = makeHooks();
    const rc = new RecoveryCoordinator({ hooks: h.hooks, events, sleep: noSleep });
    const out = await rc.recover(RecoveryTrigger.RELAY_FAILURE, { connectionId: "c1", sessionId: "s1" });
    assert.equal(out.action, RecoveryAction.SWITCH_RELAY);
    assert.ok(h.ran.includes("switchRelay"));
    assert.ok(seen.includes(ReliabilityEventType.RELAY_FAILOVER));
  });

  it("exhausted reconnects → graceful fail (not recovered)", async () => {
    const h = makeHooks({ succeedAfter: -1 }); // never succeeds
    const rc = new RecoveryCoordinator({ hooks: h.hooks, sleep: noSleep, retryPolicy: { maxAttempts: 3, baseDelayMs: 1, jitter: false } });
    const out = await rc.recover(RecoveryTrigger.UNEXPECTED_DISCONNECT, { connectionId: "c1", sessionId: "s1" });
    assert.equal(out.recovered, false);
    assert.ok(h.ran.includes("gracefulFail"));
  });
});

// ---------------------------------------------------------------------------
describe("manager — recovery scenarios", () => {
  let ctx, conn;
  beforeEach(async () => {
    ctx = makeManager();
    conn = await ctx.manager.registerConnection({ deviceId: "d1", peerId: "d2", sessionId: "s1", state: ConnectionState.CONNECTED });
  });

  it("recovers an unexpected disconnect, preserving the session", async () => {
    const log = recordEvents(ctx.events);
    const out = await ctx.manager.recover(conn.connectionId, RecoveryTrigger.UNEXPECTED_DISCONNECT, { actingDevice: "d1" });
    assert.equal(out.recovery.recovered, true);
    assert.equal(out.recovery.sessionPreserved, true);
    assert.equal(out.connection.state, ConnectionState.CONNECTED);
    assert.ok(out.connection.reconnectCount >= 1);
    assert.equal(out.connection.recoveryCount, 1);
    assert.ok(log.ofType(ReliabilityEventType.RECOVERY_SUCCEEDED).length === 1);
  });

  it("WiFi↔mobile + NAT rebind refresh candidates", async () => {
    const wm = await ctx.manager.reportNetworkEvent(conn.connectionId, RecoveryTrigger.WIFI_TO_MOBILE, { actingDevice: "d1" });
    assert.equal(wm.recovery.action, RecoveryAction.REFRESH_CANDIDATES);
    const nat = await ctx.manager.reportNetworkEvent(conn.connectionId, RecoveryTrigger.NAT_REBIND, { actingDevice: "d1" });
    assert.equal(nat.recovery.action, RecoveryAction.REFRESH_CANDIDATES);
    assert.ok(ctx.hooks.ran.includes("refreshCandidates"));
  });

  it("recovery failure drives the connection to FAILED", async () => {
    ctx.manager.recovery.hooks = { reconnect: async () => false, resume: async () => false, gracefulFail: async () => true };
    const out = await ctx.manager.recover(conn.connectionId, RecoveryTrigger.UNEXPECTED_DISCONNECT, { retryPolicy: { maxAttempts: 2, baseDelayMs: 1, jitter: false } });
    assert.equal(out.recovery.recovered, false);
    assert.equal(out.connection.state, ConnectionState.FAILED);
  });

  it("manual reconnect works", async () => {
    await ctx.manager.markDisconnected(conn.connectionId);
    const out = await ctx.manager.reconnect(conn.connectionId, { actingDevice: "d1" });
    assert.equal(out.connection.state, ConnectionState.CONNECTED);
  });
});

// ---------------------------------------------------------------------------
describe("health computation", () => {
  it("scores high for fresh + low latency + stable, low for lossy", () => {
    const good = computeHealth({ latencyMs: 20, missedHeartbeats: 0, reconnectCount: 0, ageMs: 60_000, sinceActivityMs: 0 });
    assert.ok(good.score > 0.8);
    assert.equal(good.status, HealthStatus.HEALTHY);
    const bad = computeHealth({ latencyMs: 900, missedHeartbeats: 5, reconnectCount: 4, ageMs: 0, sinceActivityMs: 100_000, timeoutMs: 15_000 });
    assert.ok(bad.score < 0.4);
    assert.equal(bad.status, HealthStatus.UNHEALTHY);
  });

  it("packet loss + jitter are inert placeholders", () => {
    const h = computeHealth({ latencyMs: 50 });
    assert.equal(h.packetLoss, null);
    assert.equal(h.jitterMs, null);
  });

  it("scoreToStatus thresholds + healthForConnection", () => {
    assert.equal(scoreToStatus(0.9), HealthStatus.HEALTHY);
    assert.equal(scoreToStatus(0.5), HealthStatus.DEGRADED);
    assert.equal(scoreToStatus(0.1), HealthStatus.UNHEALTHY);
    const conn = { establishedAt: new Date(1_000).toISOString(), lastActivityAt: new Date(60_000).toISOString(), health: { latencyMs: 25, missedHeartbeats: 0 }, reconnectCount: 0 };
    const h = healthForConnection(conn, 61_000, 15_000);
    assert.ok(h.score > 0);
  });
});

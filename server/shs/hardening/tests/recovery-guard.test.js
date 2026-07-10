import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, decideRecovery, RecoveryManager } from "../recovery/recoveryManager.js";
import { SessionGuard } from "../session-guard/sessionGuard.js";
import { HardeningEventBus } from "../events/events.js";
import { RecoveryAction, FailureClass, HardeningEventType } from "../types.js";
import { UnrecoverableError, SessionGuardError } from "../errors.js";
import { HandshakeManager } from "../../manager/handshakeManager.js";
import { createInMemoryShsRepository } from "../../repository/inMemoryRepository.js";
import { RetryPolicy } from "../../retry/retry.js";
import { HandshakeState, FailureReason } from "../../types.js";

describe("recovery classification + decision", () => {
  it("classifies transient / permanent / recoverable", () => {
    assert.equal(classifyFailure({ reason: FailureReason.TIMEOUT }), FailureClass.TRANSIENT);
    assert.equal(classifyFailure({ reason: FailureReason.USER_REJECTED }), FailureClass.PERMANENT);
    assert.equal(classifyFailure({ reason: FailureReason.EXPIRED_SESSION }), FailureClass.PERMANENT);
    assert.equal(classifyFailure({ state: HandshakeState.NEGOTIATING }), FailureClass.RECOVERABLE);
  });

  it("decides resume/retry/abort honouring the retry budget", () => {
    assert.equal(decideRecovery({ state: HandshakeState.NEGOTIATING, retryCount: 0 }).action, RecoveryAction.RESUME);
    assert.equal(decideRecovery({ state: HandshakeState.TIMED_OUT, retryCount: 0 }, { reason: FailureReason.TIMEOUT }).action, RecoveryAction.RETRY);
    assert.equal(decideRecovery({ state: HandshakeState.FAILED, retryCount: 0 }, { reason: FailureReason.USER_REJECTED }).action, RecoveryAction.ABORT);
    const exhausted = decideRecovery({ state: HandshakeState.TIMED_OUT, retryCount: 3 }, { reason: FailureReason.TIMEOUT, retryPolicy: new RetryPolicy({ maxRetries: 3 }) });
    assert.equal(exhausted.action, RecoveryAction.ABORT);
  });
});

describe("RecoveryManager (drives a real HandshakeManager)", () => {
  let handshakes;
  let events;
  let clock;
  beforeEach(() => {
    let now = 1_700_000_000_000;
    clock = () => now;
    clock.advance = (ms) => (now += ms);
    handshakes = new HandshakeManager({ ...createInMemoryShsRepository(), clock });
    events = new HardeningEventBus();
  });

  it("resumes an interrupted (non-terminal) handshake", async () => {
    const rm = new RecoveryManager({ handshakes, events });
    const { session } = await handshakes.startHandshake({ initiator: "alice", responder: "bob", initiatorDevice: "d" });
    const seen = [];
    events.on("*", (e) => seen.push(e.type));
    const result = await rm.recover(session.handshakeId, "alice");
    assert.equal(result.action, RecoveryAction.RESUME);
    assert.ok(seen.includes(HardeningEventType.RECOVERY_ATTEMPTED));
    assert.ok(seen.includes(HardeningEventType.RECOVERY_SUCCEEDED));
  });

  it("retries a failed (timeout) handshake via restart", async () => {
    const rm = new RecoveryManager({ handshakes, events, retryPolicy: new RetryPolicy({ maxRetries: 2, baseMs: 100 }) });
    const { session } = await handshakes.startHandshake({ initiator: "alice", responder: "bob", initiatorDevice: "d" });
    await handshakes.failHandshake(session.handshakeId, FailureReason.TIMEOUT);
    const result = await rm.recover(session.handshakeId, "alice", { reason: FailureReason.TIMEOUT });
    assert.equal(result.action, RecoveryAction.RETRY);
    assert.equal(result.session.previousHandshakeId, session.handshakeId);
    assert.equal(result.delayMs, 100);
  });

  it("aborts an unrecoverable (permanent) handshake", async () => {
    const rm = new RecoveryManager({ handshakes, events });
    const { session } = await handshakes.startHandshake({ initiator: "alice", responder: "bob", initiatorDevice: "d" });
    await handshakes.failHandshake(session.handshakeId, FailureReason.PROTOCOL_ERROR);
    await assert.rejects(() => rm.recover(session.handshakeId, "alice", { reason: FailureReason.USER_REJECTED }), UnrecoverableError);
  });
});

describe("SessionGuard — continuous validation", () => {
  const baseSession = () => ({
    sessionId: "sess-abcdefgh",
    handshakeId: "h1",
    participants: ["alice", "bob"],
    deviceIds: { initiator: "devA", responder: "devB" },
    status: "active",
    protocolVersion: "1.0",
    encryptionKey: { algorithm: "aes-256-gcm", length: 32, keyId: "k", fingerprint: "f" },
    authenticationKey: { algorithm: "hmac-sha256", length: 32 },
    expiresAt: new Date(10_000_000).toISOString(),
  });

  it("passes a healthy session for a participant", async () => {
    const guard = new SessionGuard({ clock: () => 1000 });
    const v = await guard.validate(baseSession(), { actingUser: "alice" });
    assert.equal(v.ok, true);
    await assert.doesNotReject(() => guard.assert(baseSession(), { actingUser: "alice" }));
  });

  it("rejects non-participant, expired, unsupported version", async () => {
    const guard = new SessionGuard({ clock: () => 1000 });
    assert.equal((await guard.validate(baseSession(), { actingUser: "carol" })).ok, false);
    assert.equal((await guard.validate({ ...baseSession(), expiresAt: new Date(500).toISOString() }, { actingUser: "alice" })).ok, false);
    assert.equal((await guard.validate({ ...baseSession(), protocolVersion: "9.9" }, { actingUser: "alice" })).ok, false);
    await assert.rejects(() => guard.assert(baseSession(), { actingUser: "carol" }), SessionGuardError);
  });

  it("checks identity, device, and trust via injected lookups", async () => {
    const events = new HardeningEventBus();
    const seen = [];
    events.on(HardeningEventType.SESSION_GUARD_FAILED, (e) => seen.push(e));
    const guard = new SessionGuard({
      clock: () => 1000,
      events,
      identityLookup: async (u) => (u === "bob" ? null : { userId: u }), // bob unknown
      deviceLookup: async (_u, d) => ({ deviceId: d, trustStatus: "trusted" }),
      trustLookup: async () => ({ state: "verified" }),
    });
    const v = await guard.validate(baseSession(), { actingUser: "alice" });
    assert.equal(v.ok, false);
    assert.ok(v.reasons.some((r) => r.startsWith("unknown-identity")));
    assert.equal(seen.length, 1);

    // revoked device + compromised trust
    const guard2 = new SessionGuard({
      clock: () => 1000,
      deviceLookup: async (_u, d) => ({ deviceId: d, trustStatus: "revoked" }),
      trustLookup: async () => ({ state: "compromised" }),
    });
    const v2 = await guard2.validate(baseSession(), { actingUser: "alice" });
    assert.equal(v2.ok, false);
    assert.ok(v2.reasons.some((r) => r.startsWith("device-unusable")));
    assert.ok(v2.reasons.includes("trust-unsafe"));
  });

  it("rejects corrupted metadata (short-circuits)", async () => {
    const guard = new SessionGuard({ clock: () => 1000 });
    const v = await guard.validate({ sessionId: "sess-abcdefgh", status: "active" }, { actingUser: "alice" });
    assert.equal(v.ok, false);
    assert.ok(v.reasons.some((r) => r.startsWith("corrupted-metadata")));
  });
});

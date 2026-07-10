import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ReplayGuard } from "../replay/replayGuard.js";
import { RecoveryCoordinator, RECOVERY_PLANS } from "../recovery/recoveryCoordinator.js";
import { HardeningEventBus } from "../events/events.js";
import { MetricsRegistry } from "../observability/metrics.js";
import { ReplayVerdict, HardeningEventType, RecoveryKind, RecoveryAction } from "../types/types.js";
import { ReplayRejectedError, UnrecoverableError, HardeningValidationError } from "../errors.js";
import { makeClock, makeSessionId, captureEvents } from "./helpers.js";

describe("ReplayGuard", () => {
  let events, metrics, guard, sid;
  beforeEach(() => {
    events = new HardeningEventBus();
    metrics = new MetricsRegistry();
    guard = new ReplayGuard({ events, metrics, clock: makeClock() });
    sid = makeSessionId(1);
  });

  it("accepts fresh messages in order and rejects an exact duplicate", () => {
    assert.equal(guard.accept({ sessionId: sid, generation: 0, messageNumber: 0, nonce: "a" }).ok, true);
    assert.equal(guard.accept({ sessionId: sid, generation: 0, messageNumber: 1, nonce: "b" }).ok, true);
    const dup = guard.accept({ sessionId: sid, generation: 0, messageNumber: 0, nonce: "c" });
    assert.equal(dup.ok, false);
    assert.equal(dup.verdict, ReplayVerdict.DUPLICATE_MESSAGE);
  });

  it("detects a duplicate nonce (duplicate ciphertext) even with a new number", () => {
    guard.accept({ sessionId: sid, generation: 0, messageNumber: 0, nonce: "same" });
    const dup = guard.accept({ sessionId: sid, generation: 0, messageNumber: 1, nonce: "same" });
    assert.equal(dup.verdict, ReplayVerdict.DUPLICATE_NONCE);
  });

  it("rejects a generation rollback (downgrade protection)", () => {
    guard.accept({ sessionId: sid, generation: 5, messageNumber: 0 });
    const rolled = guard.accept({ sessionId: sid, generation: 4, messageNumber: 0 });
    assert.equal(rolled.verdict, ReplayVerdict.GENERATION_ROLLBACK);
  });

  it("emits replay-detected events + counts metrics", () => {
    const { seen } = captureEvents(events);
    guard.accept({ sessionId: sid, generation: 0, messageNumber: 0 });
    guard.accept({ sessionId: sid, generation: 0, messageNumber: 0 }); // dup
    assert.ok(seen.types().includes(HardeningEventType.REPLAY_DETECTED));
    assert.ok(seen.types().includes(HardeningEventType.REPLAY_ACCEPTED));
    assert.equal(metrics.snapshot().counters["replay_accepted_total"], 1);
    assert.ok(metrics.snapshot().counters['replay_rejected_total{verdict="duplicate-message"}'] >= 1);
  });

  it("assertFresh throws on a replay", () => {
    guard.assertFresh({ sessionId: sid, generation: 0, messageNumber: 0 });
    assert.throws(() => guard.assertFresh({ sessionId: sid, generation: 0, messageNumber: 0 }), ReplayRejectedError);
  });

  it("advancing generation raises the floor + clears the window", () => {
    guard.accept({ sessionId: sid, generation: 0, messageNumber: 0 });
    guard.advanceGeneration(sid, 1);
    // message 0 at the NEW generation is fresh again (numbers restart per generation)
    assert.equal(guard.accept({ sessionId: sid, generation: 1, messageNumber: 0 }).ok, true);
    // but generation 0 is now below the floor → rollback
    assert.equal(guard.accept({ sessionId: sid, generation: 0, messageNumber: 5 }).verdict, ReplayVerdict.GENERATION_ROLLBACK);
  });

  it("reconnect recovery: restore re-seeds the floor so stale messages are refused", () => {
    guard.restore(sid, { generation: 3, highWater: 100 });
    const status = guard.status(sid);
    assert.equal(status.generationFloor, 3);
    assert.equal(guard.accept({ sessionId: sid, generation: 2, messageNumber: 0 }).verdict, ReplayVerdict.GENERATION_ROLLBACK);
  });

  it("reset clears a session + emits a reset event", () => {
    const { seen } = captureEvents(events);
    guard.accept({ sessionId: sid, generation: 0, messageNumber: 0 });
    guard.reset(sid);
    assert.equal(guard.status(sid), null);
    assert.ok(seen.types().includes(HardeningEventType.REPLAY_WINDOW_RESET));
  });

  it("expires TTL-aged entries", () => {
    const clock = makeClock();
    const g = new ReplayGuard({ clock, ttlMs: 1000 });
    g.accept({ sessionId: sid, generation: 0, messageNumber: 0, nonce: "n" });
    clock.advance(1000);
    assert.ok(g.expire().expired >= 1);
  });

  it("rejects a malformed replay context", () => {
    assert.throws(() => guard.accept({ sessionId: "bad" }), HardeningValidationError);
  });
});

describe("RecoveryCoordinator", () => {
  it("recovers interrupted encryption by destroying transient keys", async () => {
    const events = new HardeningEventBus();
    const { seen } = captureEvents(events);
    let destroyed = false;
    const rc = new RecoveryCoordinator({ events, hooks: { destroyTransientKeys: () => { destroyed = true; } } });
    const out = await rc.recover({ kind: RecoveryKind.INTERRUPTED_ENCRYPTION, sessionId: makeSessionId(1) });
    assert.equal(out.recovered, true);
    assert.equal(out.action, RecoveryAction.CLEANUP_AND_RETRY);
    assert.ok(destroyed, "transient keys destroyed");
    assert.ok(seen.types().includes(HardeningEventType.RECOVERY_COMPLETED));
  });

  it("chain mismatch resets the replay window; generation mismatch drops the message", async () => {
    let reset = false;
    const rc = new RecoveryCoordinator({ hooks: { resetReplayWindow: () => { reset = true; } } });
    assert.equal((await rc.recover({ kind: RecoveryKind.CHAIN_MISMATCH })).action, RecoveryAction.RESET_REPLAY_WINDOW);
    assert.ok(reset);
    assert.equal((await rc.recover({ kind: RecoveryKind.GENERATION_MISMATCH })).action, RecoveryAction.DROP_MESSAGE);
  });

  it("repository corruption is unrecoverable (escalates + throws)", async () => {
    let escalated = false;
    const rc = new RecoveryCoordinator({ hooks: { escalate: () => { escalated = true; } } });
    await assert.rejects(() => rc.recover({ kind: RecoveryKind.REPOSITORY_CORRUPTION }), UnrecoverableError);
    assert.ok(escalated);
    assert.equal(RECOVERY_PLANS[RecoveryKind.REPOSITORY_CORRUPTION].recoverable, false);
  });

  it("plan() reports the mapped action without executing", () => {
    const rc = new RecoveryCoordinator();
    assert.equal(rc.plan(RecoveryKind.CORRUPTED_METADATA).action, RecoveryAction.QUARANTINE_RECORD);
  });
});

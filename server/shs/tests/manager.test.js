import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { HandshakeState, HandshakeEventType, MessageType, FailureReason } from "../types.js";
import {
  HandshakeNotFoundError,
  HandshakeOwnershipError,
  DuplicateHandshakeError,
  InvalidStateTransitionError,
  RetryExhaustedError,
  HandshakeValidationError,
  HandshakeExpiredError,
  UnknownPartyError,
  ProtocolVersionError,
} from "../errors.js";
import { RetryPolicy } from "../retry/retry.js";
import { makeManager, captureEvents, startAB } from "./helpers.js";

describe("HandshakeManager — lifecycle", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("start advances CREATED→INITIALIZED→WAITING and emits STARTED + a request", async () => {
    const { seen } = captureEvents(ctx.events);
    const { session, message } = await startAB(ctx.manager);
    assert.equal(session.state, HandshakeState.WAITING);
    assert.equal(session.initiator, "alice");
    assert.equal(session.responder, "bob");
    assert.equal(message.type, MessageType.REQUEST);
    assert.equal(message.handshakeId, session.handshakeId);
    // history: created, initialized, waiting
    assert.equal(session.history.length, 3);
    const types = seen.map((e) => e.type);
    assert.ok(types.includes(HandshakeEventType.STARTED));
    assert.ok(types.includes(HandshakeEventType.STATE_CHANGED));
  });

  it("full happy path: start → accept → complete", async () => {
    const { seen } = captureEvents(ctx.events);
    const { session } = await startAB(ctx.manager);
    const acc = await ctx.manager.acceptHandshake(session.handshakeId, "bob", {});
    assert.equal(acc.session.state, HandshakeState.NEGOTIATING);
    assert.equal(acc.message.type, MessageType.ACCEPT);
    assert.ok(acc.session.negotiatedCapabilities.length > 0);

    const comp = await ctx.manager.completeHandshake(session.handshakeId, "alice");
    assert.equal(comp.session.state, HandshakeState.COMPLETED);
    assert.equal(comp.session.isTerminal, true);
    assert.ok(comp.session.completedAt);
    assert.equal(comp.message.type, MessageType.COMPLETE);

    const types = seen.map((e) => e.type);
    for (const t of [HandshakeEventType.STARTED, HandshakeEventType.NEGOTIATING, HandshakeEventType.ACCEPTED, HandshakeEventType.COMPLETED]) {
      assert.ok(types.includes(t), `missing ${t}`);
    }
  });

  it("reject (responder), cancel (initiator) terminals", async () => {
    const a = await startAB(ctx.manager);
    const rej = await ctx.manager.rejectHandshake(a.session.handshakeId, "bob", "busy");
    assert.equal(rej.session.state, HandshakeState.REJECTED);
    assert.equal(rej.session.reason, "busy");
    assert.equal(rej.session.terminatedBy, "responder");

    const b = await ctx.manager.startHandshake({ initiator: "alice", responder: "carol", initiatorDevice: "dev-a" });
    const can = await ctx.manager.cancelHandshake(b.session.handshakeId, "alice");
    assert.equal(can.session.state, HandshakeState.CANCELLED);
    assert.equal(can.session.terminatedBy, "initiator");
  });

  it("enforces roles (ownership)", async () => {
    const { session } = await startAB(ctx.manager);
    await assert.rejects(() => ctx.manager.acceptHandshake(session.handshakeId, "alice", {}), HandshakeOwnershipError); // initiator can't accept
    await assert.rejects(() => ctx.manager.rejectHandshake(session.handshakeId, "alice"), HandshakeOwnershipError);
    await assert.rejects(() => ctx.manager.cancelHandshake(session.handshakeId, "bob"), HandshakeOwnershipError); // responder can't cancel
    await assert.rejects(() => ctx.manager.completeHandshake(session.handshakeId, "carol"), HandshakeOwnershipError); // non-party
  });

  it("unknown handshake id throws", async () => {
    await assert.rejects(() => ctx.manager.getHandshake("nope"), HandshakeNotFoundError);
    await assert.rejects(() => ctx.manager.acceptHandshake("nope", "bob"), HandshakeNotFoundError);
  });

  it("rejects a duplicate active handshake between the same pair", async () => {
    await startAB(ctx.manager);
    await assert.rejects(() => startAB(ctx.manager), DuplicateHandshakeError);
    // but after it terminates a new one is allowed
    const active = await ctx.manager.getActiveBetween("alice", "bob");
    await ctx.manager.cancelHandshake(active.handshakeId, "alice");
    await assert.doesNotReject(() => startAB(ctx.manager));
  });

  it("illegal transitions are blocked (accept after complete)", async () => {
    const { session } = await startAB(ctx.manager);
    await ctx.manager.acceptHandshake(session.handshakeId, "bob", {});
    await ctx.manager.completeHandshake(session.handshakeId, "alice");
    // completing again → already terminal
    await assert.rejects(() => ctx.manager.completeHandshake(session.handshakeId, "alice"), HandshakeValidationError);
    // accepting a completed one → ownership ok (bob) but terminal → validation/transition error
    await assert.rejects(() => ctx.manager.acceptHandshake(session.handshakeId, "bob", {}), (e) =>
      e instanceof HandshakeValidationError || e instanceof HandshakeExpiredError || e instanceof InvalidStateTransitionError,
    );
  });

  it("validateState guards state-specific ops", async () => {
    const { session } = await startAB(ctx.manager);
    await assert.doesNotReject(() => ctx.manager.validateState(session.handshakeId, HandshakeState.WAITING));
    await assert.rejects(() => ctx.manager.validateState(session.handshakeId, HandshakeState.COMPLETED), HandshakeValidationError);
  });
});

describe("HandshakeManager — negotiation failures", () => {
  it("incompatible version fails the handshake and rethrows", async () => {
    const { manager } = makeManager();
    const { session } = await startAB(manager);
    await assert.rejects(() => manager.acceptHandshake(session.handshakeId, "bob", { version: "2.0" }), ProtocolVersionError);
    const after = await manager.getHandshake(session.handshakeId);
    assert.equal(after.state, HandshakeState.FAILED);
    assert.equal(after.reason, FailureReason.VERSION_INCOMPATIBLE);
  });

  it("missing required capability fails negotiation", async () => {
    const { manager } = makeManager({ requiredCapabilities: ["handshake.resume"] });
    const { session } = await manager.startHandshake({
      initiator: "alice", responder: "bob", initiatorDevice: "dev-a", capabilities: [],
    });
    await assert.rejects(() => manager.acceptHandshake(session.handshakeId, "bob", { capabilities: [] }));
    assert.equal((await manager.getHandshake(session.handshakeId)).state, HandshakeState.FAILED);
  });
});

describe("HandshakeManager — resume & restart", () => {
  it("resume returns a RESUME message for an active session; refuses terminal", async () => {
    const { manager } = makeManager();
    const { session } = await startAB(manager);
    const res = await manager.resumeHandshake(session.handshakeId, "alice");
    assert.equal(res.message.type, MessageType.RESUME);
    assert.equal(res.session.state, HandshakeState.WAITING); // unchanged
    await manager.cancelHandshake(session.handshakeId, "alice");
    await assert.rejects(() => manager.resumeHandshake(session.handshakeId, "alice"), HandshakeValidationError);
  });

  it("restart creates a NEW linked session and honours the retry budget", async () => {
    const { manager, events } = makeManager({ retryPolicy: new RetryPolicy({ maxRetries: 2, baseMs: 100 }) });
    const { seen } = captureEvents(events);
    const { session } = await startAB(manager);
    await manager.failHandshake(session.handshakeId, FailureReason.TIMEOUT);

    const r1 = await manager.restartHandshake(session.handshakeId, "alice");
    assert.notEqual(r1.session.handshakeId, session.handshakeId);
    assert.equal(r1.session.previousHandshakeId, session.handshakeId);
    assert.equal(r1.session.retryCount, 1);
    assert.equal(r1.session.state, HandshakeState.WAITING);
    assert.equal(r1.delayMs, 100);
    assert.ok(seen.some((e) => e.type === HandshakeEventType.RESTARTED));

    // restart the restarted one (retryCount 1 → 2 allowed), then exhaust
    await manager.failHandshake(r1.session.handshakeId, FailureReason.TIMEOUT);
    const r2 = await manager.restartHandshake(r1.session.handshakeId, "alice");
    assert.equal(r2.session.retryCount, 2);
    await manager.failHandshake(r2.session.handshakeId, FailureReason.TIMEOUT);
    await assert.rejects(() => manager.restartHandshake(r2.session.handshakeId, "alice"), RetryExhaustedError);
  });

  it("cannot restart a non-terminal handshake", async () => {
    const { manager } = makeManager();
    const { session } = await startAB(manager);
    await assert.rejects(() => manager.restartHandshake(session.handshakeId, "alice"), HandshakeValidationError);
  });
});

describe("HandshakeManager — timeout, expiry, recovery", () => {
  it("timeoutHandshake and abortHandshake reach their terminals", async () => {
    const { manager } = makeManager();
    const a = await startAB(manager);
    const t = await manager.timeoutHandshake(a.session.handshakeId);
    assert.equal(t.session.state, HandshakeState.TIMED_OUT);

    const b = await manager.startHandshake({ initiator: "alice", responder: "carol", initiatorDevice: "dev-a" });
    const ab = await manager.abortHandshake(b.session.handshakeId);
    assert.equal(ab.session.state, HandshakeState.ABORTED);
  });

  it("lazily expires a session past its deadline on read", async () => {
    const { manager, clock, events } = makeManager({ ttlMs: 1000 });
    const { seen } = captureEvents(events);
    const { session } = await startAB(manager);
    clock.advance(1500); // past expiry
    const read = await manager.getHandshake(session.handshakeId);
    assert.equal(read.state, HandshakeState.EXPIRED);
    // read-path expiry is silent (no EXPIRED event) but state persisted
    assert.equal(seen.filter((e) => e.type === HandshakeEventType.EXPIRED).length, 0);
    // a second read is stable
    assert.equal((await manager.getHandshake(session.handshakeId)).state, HandshakeState.EXPIRED);
  });

  it("accepting an expired handshake yields a clean expiry error", async () => {
    const { manager, clock } = makeManager({ ttlMs: 1000 });
    const { session } = await startAB(manager);
    clock.advance(2000);
    await assert.rejects(() => manager.acceptHandshake(session.handshakeId, "bob", {}), HandshakeExpiredError);
  });

  it("sweepExpired expires all stale active sessions and emits events", async () => {
    const { manager, clock, events } = makeManager({ ttlMs: 1000 });
    const { seen } = captureEvents(events);
    await startAB(manager, "alice", "bob", "dev-a");
    await manager.startHandshake({ initiator: "alice", responder: "carol", initiatorDevice: "dev-a" });
    // one completed session should NOT be swept
    const done = await manager.startHandshake({ initiator: "carol", responder: "bob", initiatorDevice: "dev-c" });
    await manager.acceptHandshake(done.session.handshakeId, "bob", {});
    await manager.completeHandshake(done.session.handshakeId, "carol");

    clock.advance(2000);
    const result = await manager.sweepExpired();
    assert.equal(result.expired, 2);
    assert.equal(seen.filter((e) => e.type === HandshakeEventType.EXPIRED).length, 2);
    assert.equal((await manager.listByState(HandshakeState.COMPLETED)).length, 1);
  });
});

describe("HandshakeManager — directory validation", () => {
  it("rejects unknown identities and self-handshakes", async () => {
    const { manager } = makeManager({ withDirectory: true });
    await assert.rejects(
      () => manager.startHandshake({ initiator: "alice", responder: "ghost", initiatorDevice: "dev-a" }),
      UnknownPartyError,
    );
    await assert.rejects(
      () => manager.startHandshake({ initiator: "alice", responder: "alice", initiatorDevice: "dev-a" }),
      HandshakeValidationError,
    );
  });

  it("rejects an unknown initiator device", async () => {
    const { manager } = makeManager({ withDirectory: true });
    await assert.rejects(
      () => manager.startHandshake({ initiator: "alice", responder: "bob", initiatorDevice: "ghost-dev" }),
      UnknownPartyError,
    );
    await assert.doesNotReject(() =>
      manager.startHandshake({ initiator: "alice", responder: "bob", initiatorDevice: "dev-a" }),
    );
  });
});

describe("HandshakeManager — concurrency & queries", () => {
  it("supports many concurrent independent handshakes", async () => {
    const { manager } = makeManager();
    const pairs = [
      ["alice", "bob", "dev-a"],
      ["alice", "carol", "dev-a"],
      ["bob", "carol", "dev-b"],
      ["carol", "alice", "dev-c"],
    ];
    const started = await Promise.all(pairs.map(([i, r, d]) => manager.startHandshake({ initiator: i, responder: r, initiatorDevice: d })));
    assert.equal(new Set(started.map((s) => s.session.handshakeId)).size, 4); // unique ids
    // advance each independently
    await manager.acceptHandshake(started[0].session.handshakeId, "bob", {});
    await manager.rejectHandshake(started[1].session.handshakeId, "carol");
    assert.equal((await manager.getHandshake(started[0].session.handshakeId)).state, HandshakeState.NEGOTIATING);
    assert.equal((await manager.getHandshake(started[1].session.handshakeId)).state, HandshakeState.REJECTED);

    const aliceSessions = await manager.listSessions("alice");
    assert.equal(aliceSessions.length, 3); // ab, ac, ca
    assert.ok(aliceSessions.every((s) => s.role === "initiator" || s.role === "responder"));
    assert.equal((await manager.listByState(HandshakeState.WAITING)).length, 2); // bc, ca
  });
});

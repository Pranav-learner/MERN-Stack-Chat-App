/**
 * Retransmission engine (Layer 8, Sprint 1): backoff schedule, ACK-timeout-driven resend, max-retry
 * exhaustion → FAILED, TTL expiry, reconnect flush, and the guarantee that a retransmission NEVER
 * causes duplicate delivery to the application. DB-free, deterministic clock.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeClock, makeIdGen, cipher, countEvents } from "./helpers.js";
import { MessagingEngine } from "../manager/messagingEngine.js";
import { createInMemoryMessageRepository } from "../repository/inMemoryMessageRepository.js";
import { computeBackoff, shouldRetry, resolveRetryPolicy } from "../retransmission/retransmission.js";
import { DeliveryState, MessagingEventType } from "../types/types.js";

function bundle(repo) {
  return { messages: repo.messages, inbound: repo.inbound, ackHistory: repo.ackHistory, ordering: repo.ordering };
}

describe("backoff schedule (pure)", () => {
  it("uses the plain ACK timeout for the first attempt", () => {
    assert.equal(computeBackoff(0, { jitter: false }), resolveRetryPolicy().ackTimeoutMs);
  });

  it("grows exponentially and caps at maxMs (no jitter)", () => {
    const p = { jitter: false, baseMs: 500, factor: 2, maxMs: 4000 };
    assert.equal(computeBackoff(1, p), 500);
    assert.equal(computeBackoff(2, p), 1000);
    assert.equal(computeBackoff(3, p), 2000);
    assert.equal(computeBackoff(4, p), 4000);
    assert.equal(computeBackoff(5, p), 4000, "capped");
  });

  it("stops retrying at maxRetries", () => {
    const p = { maxRetries: 3 };
    assert.equal(shouldRetry(0, p), true);
    assert.equal(shouldRetry(2, p), true);
    assert.equal(shouldRetry(3, p), false);
  });
});

describe("retransmission via the engine", () => {
  let clock, engine, repo;
  beforeEach(() => {
    clock = makeClock();
    repo = createInMemoryMessageRepository();
    // A transport that drops everything (send resolves, nothing is delivered/ACKed).
    engine = new MessagingEngine({ deviceId: "a", ...bundle(repo), transport: { send: async () => {} }, clock: clock.now, idGenerator: makeIdGen(), retryPolicy: { ackTimeoutMs: 500, baseMs: 500, factor: 2, maxRetries: 3, jitter: false } });
  });

  it("marks a sent-but-unacked message SENT with a retry deadline", async () => {
    const { message } = await engine.send({ conversationId: "c", receiverDeviceId: "b", encryptedPayload: cipher() });
    const stored = await engine.messages.findById(message.messageId);
    assert.equal(stored.state, DeliveryState.SENT);
    assert.ok(stored.nextRetryAt, "has a next-retry deadline");
  });

  it("does not retry before the deadline, retries after it", async () => {
    const { message } = await engine.send({ conversationId: "c", receiverDeviceId: "b", encryptedPayload: cipher() });
    let r = await engine.sweepRetries(); // now — not yet due
    assert.equal(r.retried, 0);
    clock.advance(600);
    r = await engine.sweepRetries();
    assert.equal(r.retried, 1);
    const stored = await engine.messages.findById(message.messageId);
    assert.equal(stored.retryCount, 1);
  });

  it("fails a message after max retries are exhausted", async () => {
    const events = [];
    engine.onEvent("*", (e) => events.push(e));
    const { message } = await engine.send({ conversationId: "c", receiverDeviceId: "b", encryptedPayload: cipher() });
    // Keep advancing well past each deadline until it terminates.
    for (let i = 0; i < 6; i++) {
      clock.advance(60_000);
      await engine.sweepRetries();
    }
    const stored = await engine.messages.findById(message.messageId);
    assert.equal(stored.state, DeliveryState.FAILED);
    assert.equal(countEvents(events, MessagingEventType.MESSAGE_FAILED), 1);
    assert.equal(countEvents(events, MessagingEventType.RETRY_FAILED), 1);
    assert.equal(countEvents(events, MessagingEventType.RETRY_SCHEDULED), 3, "retried maxRetries times before failing");
  });

  it("expires a message that outlives its TTL during a retry sweep", async () => {
    const events = [];
    engine.onEvent("*", (e) => events.push(e));
    const { message } = await engine.send({ conversationId: "c", receiverDeviceId: "b", encryptedPayload: cipher(), ttlMs: 1000 });
    clock.advance(2000); // past both the retry deadline and the TTL
    await engine.sweepRetries();
    const stored = await engine.messages.findById(message.messageId);
    assert.equal(stored.state, DeliveryState.EXPIRED);
    assert.equal(countEvents(events, MessagingEventType.MESSAGE_EXPIRED), 1);
  });

  it("sweepExpired expires active messages past their TTL", async () => {
    const { message } = await engine.send({ conversationId: "c", receiverDeviceId: "b", encryptedPayload: cipher(), ttlMs: 1000 });
    clock.advance(1500);
    const r = await engine.sweepExpired();
    assert.equal(r.expired, 1);
    assert.equal((await engine.messages.findById(message.messageId)).state, DeliveryState.EXPIRED);
  });
});

describe("retransmission never double-delivers, and reconnect flush", () => {
  it("retransmits on lost ACKs without re-delivering to the app", async () => {
    const clock = makeClock();
    const registry = new Map();
    const dropAck = { on: true };
    // DATA is delivered to the peer; ACKs are dropped (simulating a lost-ACK path).
    const transport = {
      async send(env) {
        if (env.type === "ack" && dropAck.on) return; // ACK lost
        const peer = registry.get(env.receiver);
        if (!peer) { const e = new Error("no conn"); e.code = "ERR_DATAPLANE_NO_CONNECTION"; throw e; }
        await Promise.resolve();
        await peer.receive(env);
      },
    };
    const a = new MessagingEngine({ deviceId: "a", ...bundle(createInMemoryMessageRepository()), transport, clock: clock.now, idGenerator: makeIdGen("a"), retryPolicy: { ackTimeoutMs: 500, jitter: false } });
    const b = new MessagingEngine({ deviceId: "b", ...bundle(createInMemoryMessageRepository()), transport, clock: clock.now, idGenerator: makeIdGen("b"), retryPolicy: { ackTimeoutMs: 500, jitter: false } });
    registry.set("a", a);
    registry.set("b", b);
    const delivered = [];
    b.onMessage((d) => delivered.push(d));

    const { message } = await a.send({ conversationId: "c", receiverDeviceId: "b", encryptedPayload: cipher("once") });
    assert.equal(delivered.length, 1, "delivered exactly once");
    assert.equal((await a.messages.findById(message.messageId)).state, DeliveryState.SENT, "ack was lost → still awaiting ACK");

    // Retransmit a few times with the ACK still dropping — peer sees duplicates, app is untouched.
    for (let i = 0; i < 3; i++) {
      clock.advance(60_000);
      await a.sweepRetries();
    }
    assert.equal(delivered.length, 1, "retransmissions never re-deliver");

    // Now let ACKs through and retransmit once more → acknowledged.
    dropAck.on = false;
    clock.advance(60_000);
    await a.sweepRetries();
    assert.equal((await a.messages.findById(message.messageId)).state, DeliveryState.ACKNOWLEDGED);
    assert.equal(delivered.length, 1);
  });

  it("flushPending re-transmits queued messages after a reconnect", async () => {
    const clock = makeClock();
    const registry = new Map();
    const link = { up: false };
    const transport = {
      async send(env) {
        if (!link.up) { const e = new Error("down"); e.code = "ERR_DATAPLANE_NO_CONNECTION"; throw e; }
        const peer = registry.get(env.receiver);
        await Promise.resolve();
        await peer.receive(env);
      },
    };
    const a = new MessagingEngine({ deviceId: "a", ...bundle(createInMemoryMessageRepository()), transport, clock: clock.now, idGenerator: makeIdGen("a") });
    const b = new MessagingEngine({ deviceId: "b", ...bundle(createInMemoryMessageRepository()), transport, clock: clock.now, idGenerator: makeIdGen("b") });
    registry.set("a", a);
    registry.set("b", b);
    const delivered = [];
    b.onMessage((d) => delivered.push(d));

    const { message } = await a.send({ conversationId: "c", receiverDeviceId: "b", encryptedPayload: cipher() });
    assert.equal((await a.messages.findById(message.messageId)).state, DeliveryState.QUEUED, "queued while offline");
    assert.equal(delivered.length, 0);

    link.up = true;
    const r = await a.flushPending();
    assert.equal(r.flushed, 1);
    assert.equal(delivered.length, 1);
    assert.equal((await a.messages.findById(message.messageId)).state, DeliveryState.ACKNOWLEDGED);
  });
});

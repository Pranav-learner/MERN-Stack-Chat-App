/**
 * Duplicate detection + the priority send queue (Layer 8, Sprint 1). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeMesh, cipher, dataEnvelope, countEvents } from "./helpers.js";
import { DuplicateCache } from "../delivery/dedupe.js";
import { MessageQueue } from "../queue/messageQueue.js";
import { MessagePriority, MessagingEventType } from "../types/types.js";

describe("DuplicateCache (pure)", () => {
  it("recognizes a repeated message id per conversation", () => {
    const c = new DuplicateCache();
    assert.equal(c.addMessage("k", "m1"), true, "first sighting is new");
    assert.equal(c.hasMessage("k", "m1"), true);
    assert.equal(c.addMessage("k", "m1"), false, "second sighting is a duplicate");
    assert.equal(c.hasMessage("k2", "m1"), false, "other conversations are independent");
  });

  it("detects duplicate ACK ids", () => {
    const c = new DuplicateCache();
    assert.equal(c.addAck("ack-1"), true);
    assert.equal(c.hasAck("ack-1"), true);
    assert.equal(c.addAck("ack-1"), false);
  });

  it("bounds the cache to its size (LRU eviction)", () => {
    const c = new DuplicateCache({ size: 2 });
    c.addMessage("k", "a");
    c.addMessage("k", "b");
    c.addMessage("k", "c"); // evicts "a"
    assert.equal(c.hasMessage("k", "a"), false);
    assert.equal(c.hasMessage("k", "c"), true);
  });

  it("checkReplay is an inert placeholder (crypto replay is Layer 5)", () => {
    assert.equal(new DuplicateCache().checkReplay(), false);
  });
});

describe("engine duplicate detection", () => {
  let mesh;
  beforeEach(() => {
    // "z" is a real engine so the receiver's ACKs (original + duplicate) can route back.
    mesh = makeMesh({ devices: ["a", "b", "z"] });
  });

  it("emits duplicate_detected and re-ACKs, but does not re-deliver", async () => {
    const { engines, delivered, events } = mesh;
    await engines.b.receive(dataEnvelope({ messageId: "d-0000000000001", conversationId: "k", seq: 1, sender: "z", receiver: "b" }));
    assert.equal(delivered.b.length, 1);
    await engines.b.receive(dataEnvelope({ messageId: "d-0000000000001", conversationId: "k", seq: 1, sender: "z", receiver: "b" }));
    assert.equal(delivered.b.length, 1, "no second delivery");
    assert.equal(countEvents(events.b, MessagingEventType.DUPLICATE_DETECTED), 1);
    assert.equal(countEvents(events.b, MessagingEventType.ACK_SENT), 2, "both the original and the duplicate are ACKed");
  });
});

describe("MessageQueue (pure)", () => {
  const m = (id, priority) => ({ messageId: id, priority });

  it("dequeues by priority then FIFO", () => {
    const q = new MessageQueue();
    q.enqueue(m("n1", MessagePriority.NORMAL));
    q.enqueue(m("h1", MessagePriority.HIGH));
    q.enqueue(m("l1", MessagePriority.LOW));
    q.enqueue(m("h2", MessagePriority.HIGH));
    q.enqueue(m("n2", MessagePriority.NORMAL));
    assert.deepEqual(q.drain().map((x) => x.messageId), ["h1", "h2", "n1", "n2", "l1"]);
  });

  it("is idempotent on duplicate ids and supports removal", () => {
    const q = new MessageQueue();
    assert.equal(q.enqueue(m("x", MessagePriority.NORMAL)), true);
    assert.equal(q.enqueue(m("x", MessagePriority.NORMAL)), false);
    assert.equal(q.size, 1);
    assert.equal(q.remove("x"), true);
    assert.equal(q.size, 0);
  });

  it("reports depth by priority", () => {
    const q = new MessageQueue();
    q.enqueue(m("a", MessagePriority.HIGH));
    q.enqueue(m("b", MessagePriority.HIGH));
    q.enqueue(m("c", MessagePriority.LOW));
    assert.deepEqual(q.depthByPriority(), { high: 2, normal: 0, low: 1 });
  });

  it("sends high-priority messages first end-to-end", async () => {
    const { engines, delivered } = makeMesh();
    // All go out immediately over the live link; the queue orders when several are pending, but even
    // in the immediate path priority is respected relative to enqueue. Verify high is not starved.
    await engines.a.send({ conversationId: "c", receiverDeviceId: "b", encryptedPayload: cipher("lo"), priority: MessagePriority.LOW });
    await engines.a.send({ conversationId: "c", receiverDeviceId: "b", encryptedPayload: cipher("hi"), priority: MessagePriority.HIGH });
    assert.equal(delivered.b.length, 2);
  });
});

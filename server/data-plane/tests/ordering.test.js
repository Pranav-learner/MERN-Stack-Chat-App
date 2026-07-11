/**
 * Message ordering (Layer 8, Sprint 1): sequence numbers, out-of-order arrival, gap detection, the
 * reorder buffer, contiguous draining, and buffer-cap force-recovery. Exercises both the pure
 * OrderingEngine and the engine's inbound path. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeMesh, dataEnvelope, countEvents } from "./helpers.js";
import { OrderingEngine } from "../ordering/ordering.js";
import { ReceiveOutcome, MessagingEventType } from "../types/types.js";

describe("OrderingEngine (pure)", () => {
  it("delivers an in-order stream immediately", () => {
    const o = new OrderingEngine();
    for (let seq = 1; seq <= 5; seq++) {
      const r = o.accept("c", seq, { seq });
      assert.equal(r.outcome, ReceiveOutcome.DELIVERED);
      assert.equal(r.deliver.length, 1);
    }
    assert.equal(o.expected("c"), 6);
  });

  it("buffers a gap and drains contiguously when it fills", () => {
    const o = new OrderingEngine();
    assert.equal(o.accept("c", 2, { seq: 2 }).outcome, ReceiveOutcome.GAP);
    assert.equal(o.accept("c", 3, { seq: 3 }).outcome, ReceiveOutcome.GAP);
    assert.equal(o.bufferSize("c"), 2);
    const r = o.accept("c", 1, { seq: 1 });
    assert.equal(r.outcome, ReceiveOutcome.DELIVERED);
    assert.deepEqual(r.deliver.map((d) => d.seq), [1, 2, 3]);
    assert.equal(r.recovered, true);
    assert.equal(o.bufferSize("c"), 0);
  });

  it("classifies an old/low sequence as a duplicate", () => {
    const o = new OrderingEngine();
    o.accept("c", 1, { seq: 1 });
    o.accept("c", 2, { seq: 2 });
    const r = o.accept("c", 1, { seq: 1 });
    assert.equal(r.outcome, ReceiveOutcome.DUPLICATE);
    assert.equal(r.deliver.length, 0);
  });

  it("does not double-buffer the same future sequence", () => {
    const o = new OrderingEngine();
    o.accept("c", 5, { seq: 5 });
    o.accept("c", 5, { seq: 5 });
    assert.equal(o.bufferSize("c"), 1);
  });

  it("force-recovers past a permanently-missing sequence when the buffer overflows", () => {
    const o = new OrderingEngine({ bufferLimit: 3 });
    // seq 1 never arrives; fill the buffer beyond the cap.
    o.accept("c", 2, { seq: 2 });
    o.accept("c", 3, { seq: 3 });
    o.accept("c", 4, { seq: 4 });
    const r = o.accept("c", 5, { seq: 5 }); // now > cap → force recover from the lowest buffered
    assert.equal(r.recovered, true);
    assert.deepEqual(r.deliver.map((d) => d.seq), [2, 3, 4, 5]);
    assert.equal(o.expected("c"), 6);
  });

  it("seeds expected from persisted metadata and snapshots for persistence", () => {
    const o = new OrderingEngine();
    o.seed("c", 10);
    assert.equal(o.expected("c"), 10);
    o.accept("c", 11, { seq: 11 }); // gap (expected 10)
    const snap = o.snapshot("c");
    assert.equal(snap.expected, 10);
    assert.deepEqual(snap.buffered, [11]);
  });

  it("keeps conversations independent", () => {
    const o = new OrderingEngine();
    o.accept("c1", 1, { seq: 1 });
    o.accept("c2", 5, { seq: 5 }); // buffered for c2
    assert.equal(o.expected("c1"), 2);
    assert.equal(o.expected("c2"), 1);
  });
});

describe("engine inbound ordering", () => {
  let mesh;
  beforeEach(() => {
    // "z" is a real engine so the ACKs the receiver sends back to it can route.
    mesh = makeMesh({ devices: ["a", "b", "z"] });
  });

  it("delivers out-of-order arrivals to the app in sequence order", async () => {
    const { engines, delivered } = mesh;
    await engines.b.receive(dataEnvelope({ messageId: "ord-000000000003", conversationId: "k", seq: 3, sender: "z" }));
    await engines.b.receive(dataEnvelope({ messageId: "ord-000000000001", conversationId: "k", seq: 1, sender: "z" }));
    await engines.b.receive(dataEnvelope({ messageId: "ord-000000000002", conversationId: "k", seq: 2, sender: "z" }));
    assert.deepEqual(delivered.b.map((d) => d.seq), [1, 2, 3]);
  });

  it("emits ordering_gap_detected then ordering_recovered", async () => {
    const { engines, events } = mesh;
    await engines.b.receive(dataEnvelope({ messageId: "g-0000000000002", conversationId: "k", seq: 2, sender: "z" }));
    assert.equal(countEvents(events.b, MessagingEventType.ORDERING_GAP_DETECTED), 1);
    await engines.b.receive(dataEnvelope({ messageId: "g-0000000000001", conversationId: "k", seq: 1, sender: "z" }));
    assert.equal(countEvents(events.b, MessagingEventType.ORDERING_RECOVERED), 1);
  });

  it("ACKs even a buffered (out-of-order) message — its transmission still succeeded", async () => {
    const { engines, events } = mesh;
    await engines.b.receive(dataEnvelope({ messageId: "a-0000000000005", conversationId: "k", seq: 5, sender: "z", receiver: "b" }));
    assert.equal(countEvents(events.b, MessagingEventType.ACK_SENT), 1);
  });

  it("persists ordering metadata (expected) as it advances", async () => {
    const { engines } = mesh;
    await engines.b.receive(dataEnvelope({ messageId: "m-0000000000001", conversationId: "k", seq: 1, sender: "z" }));
    await engines.b.receive(dataEnvelope({ messageId: "m-0000000000002", conversationId: "k", seq: 2, sender: "z" }));
    const meta = await engines.b.orderingRepo.getMetadata("k");
    assert.equal(meta.expected, 3);
  });
});

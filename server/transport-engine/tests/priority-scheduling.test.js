/**
 * Priority scheduling, starvation prevention, and multiplexing (Layer 8, Sprint 2). DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeMesh, fakeCiphertext } from "./helpers.js";
import { priorityWeight, effectiveWeight, compareCandidates, isStarving } from "../priorities/priority.js";
import { TransferScheduler } from "../scheduler/scheduler.js";
import { Multiplexer } from "../multiplexing/multiplexer.js";
import { TransferPriority, TransferState } from "../types/types.js";

describe("priority model", () => {
  it("orders control > chat > image > document > file > background", () => {
    const p = TransferPriority;
    assert.ok(priorityWeight(p.CONTROL) > priorityWeight(p.CHAT));
    assert.ok(priorityWeight(p.CHAT) > priorityWeight(p.IMAGE));
    assert.ok(priorityWeight(p.IMAGE) > priorityWeight(p.DOCUMENT));
    assert.ok(priorityWeight(p.DOCUMENT) > priorityWeight(p.FILE));
    assert.ok(priorityWeight(p.FILE) > priorityWeight(p.BACKGROUND));
  });

  it("aging boosts a waiting chunk's effective weight", () => {
    const fresh = effectiveWeight(TransferPriority.BACKGROUND, 0, { agingMs: 1000 });
    const aged = effectiveWeight(TransferPriority.BACKGROUND, 10_000, { agingMs: 1000 });
    assert.ok(aged > fresh);
  });

  it("prevents starvation: a long-waiting low-priority chunk out-ranks a fresh high-priority one", () => {
    const now = 100_000;
    const staleBackground = { priority: TransferPriority.BACKGROUND, readySince: now - 60_000, index: 0 };
    const freshControl = { priority: TransferPriority.CONTROL, readySince: now, index: 0 };
    // compareCandidates returns < 0 when the FIRST arg should go first.
    assert.ok(compareCandidates(staleBackground, freshControl, now, { agingMs: 1000 }) < 0, "aged background wins");
    assert.ok(isStarving(staleBackground.readySince, now, 5000));
  });
});

describe("TransferScheduler", () => {
  it("picks the highest effective weight, earliest on ties", () => {
    const now = 1000;
    const s = new TransferScheduler({ agingMs: 100_000 });
    const candidates = [
      { transferId: "bg", priority: TransferPriority.BACKGROUND, readySince: now, index: 0 },
      { transferId: "ctrl", priority: TransferPriority.CONTROL, readySince: now, index: 0 },
      { transferId: "img", priority: TransferPriority.IMAGE, readySince: now, index: 0 },
    ];
    assert.equal(s.pick(candidates, now).transferId, "ctrl");
    const ordered = s.order(candidates, now).map((c) => c.transferId);
    assert.deepEqual(ordered, ["ctrl", "img", "bg"]);
  });
});

describe("Multiplexer", () => {
  it("registers independent streams and isolates by conversation", () => {
    const m = new Multiplexer();
    m.register("t1", { conversationId: "c1", priority: "file" });
    m.register("t2", { conversationId: "c1", priority: "image" });
    m.register("t3", { conversationId: "c2", priority: "file" });
    assert.equal(m.activeCount, 3);
    assert.equal(m.streamsForConversation("c1").length, 2);
    assert.equal(m.streamsForConversation("c2").length, 1);
  });

  it("rotates the serving order fairly (round-robin)", () => {
    const m = new Multiplexer();
    m.register("a");
    m.register("b");
    m.register("c");
    assert.deepEqual(m.rotation(), ["a", "b", "c"]);
    assert.deepEqual(m.rotation(), ["b", "c", "a"]);
    assert.deepEqual(m.rotation(), ["c", "a", "b"]);
  });

  it("unregister keeps the rotation consistent", () => {
    const m = new Multiplexer();
    m.register("a");
    m.register("b");
    m.unregister("a");
    assert.equal(m.has("a"), false);
    assert.deepEqual(m.rotation(), ["b"]);
  });

  it("respects the concurrency cap flag", () => {
    const m = new Multiplexer({ maxConcurrent: 1 });
    m.register("a");
    assert.equal(m.hasCapacity, false);
  });
});

describe("engine-level multiplexing", () => {
  it("runs many concurrent transfers to completion, isolated per conversation", async () => {
    const mesh = makeMesh({ options: { windowSize: 3, chunkSize: 32 * 1024, maxConcurrent: 8 } });
    const payloads = [];
    for (let i = 0; i < 6; i++) {
      const bytes = (60 + i * 40) * 1024;
      const payload = fakeCiphertext(bytes, i + 1);
      payloads.push(payload);
      await mesh.engines.alice.startTransfer({ conversationId: `conv-${i % 3}`, receiverDeviceId: "bob", payload, payloadMeta: { kind: i % 2 ? "image" : "file" } });
    }
    await mesh.net.flush();
    assert.equal(mesh.received.bob.length, 6, "all 6 transfers delivered");
    // Every payload arrived intact (order-independent).
    for (const payload of payloads) {
      assert.ok(mesh.received.bob.some((p) => Buffer.from(p.payload, "base64").equals(payload)), "payload delivered intact");
    }
    assert.equal((await mesh.engines.alice.listActiveTransfers()).length, 0);
  });
});

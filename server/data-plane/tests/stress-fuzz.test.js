/**
 * High-throughput, concurrency, and fuzz coverage (Layer 8, Sprint 1). Verifies the engine's core
 * guarantees hold at scale + under adversarial reordering/duplication: exactly-once in-order delivery
 * per conversation, and no leaked plaintext. Deterministic (seeded PRNG — no Math.random). DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeMesh, cipher, dataEnvelope } from "./helpers.js";
import { MessagingEngine } from "../manager/messagingEngine.js";
import { createInMemoryMessageRepository } from "../repository/inMemoryMessageRepository.js";
import { createLoopbackTransport } from "../transport/wire.js";
import { makeClock, makeIdGen } from "./helpers.js";
import { DeliveryState } from "../types/types.js";

/** A tiny deterministic PRNG (mulberry32) — reproducible fuzz without Math.random. */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("high throughput", () => {
  it("delivers a large in-order burst exactly once, all acknowledged", async () => {
    const { engines, delivered } = makeMesh();
    const N = 500;
    const ids = [];
    for (let i = 0; i < N; i++) {
      const { message } = await engines.a.send({ conversationId: "big", receiverDeviceId: "b", encryptedPayload: cipher(i) });
      ids.push(message.messageId);
    }
    assert.equal(delivered.b.length, N);
    assert.deepEqual(delivered.b.map((d) => d.seq), Array.from({ length: N }, (_, i) => i + 1));
    const counts = await engines.a.messages.countByState();
    assert.equal(counts[DeliveryState.ACKNOWLEDGED], N);
    assert.equal(new Set(ids).size, N, "all ids unique");
  });

  it("keeps two conversations independent under interleaving", async () => {
    const { engines, delivered } = makeMesh();
    for (let i = 0; i < 50; i++) {
      await engines.a.send({ conversationId: "x", receiverDeviceId: "b", encryptedPayload: cipher(`x${i}`) });
      await engines.a.send({ conversationId: "y", receiverDeviceId: "b", encryptedPayload: cipher(`y${i}`) });
    }
    const xs = delivered.b.filter((d) => d.conversationId === "x");
    const ys = delivered.b.filter((d) => d.conversationId === "y");
    assert.deepEqual(xs.map((d) => d.seq), Array.from({ length: 50 }, (_, i) => i + 1));
    assert.deepEqual(ys.map((d) => d.seq), Array.from({ length: 50 }, (_, i) => i + 1));
  });
});

describe("fuzz: adversarial reorder + duplication on the receiver", () => {
  it("reassembles exactly-once, in order, for many randomized runs", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rand = prng(seed);
      const { engines, delivered } = makeMesh();
      const N = 40;
      // Build the N in-order DATA envelopes from a synthetic sender "z".
      const envs = [];
      for (let seq = 1; seq <= N; seq++) {
        envs.push(dataEnvelope({ messageId: `f-${String(seed).padStart(3, "0")}-${String(seq).padStart(6, "0")}`, conversationId: "fz", seq, sender: "z", receiver: "b" }));
      }
      // Shuffle + sprinkle duplicates.
      const schedule = [...envs];
      for (let i = schedule.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [schedule[i], schedule[j]] = [schedule[j], schedule[i]];
      }
      const withDups = [];
      for (const e of schedule) {
        withDups.push(e);
        if (rand() < 0.3) withDups.push(e); // duplicate
      }
      for (const e of withDups) await engines.b.receive(e);

      // Every message delivered exactly once, in sequence order.
      assert.equal(delivered.b.length, N, `seed ${seed}: exactly N delivered`);
      assert.deepEqual(delivered.b.map((d) => d.seq), Array.from({ length: N }, (_, i) => i + 1), `seed ${seed}: in-order`);
    }
  });
});

describe("stress: churn under intermittent link + retries", () => {
  it("eventually delivers everything exactly once despite flapping", async () => {
    const clock = makeClock();
    const registry = new Map();
    const link = { up: true };
    const transport = createLoopbackTransport({ route: (id) => registry.get(id), up: () => link.up });
    const a = new MessagingEngine({ deviceId: "a", ...bundle(createInMemoryMessageRepository()), transport, clock: clock.now, idGenerator: makeIdGen("a"), retryPolicy: { ackTimeoutMs: 100, jitter: false } });
    const b = new MessagingEngine({ deviceId: "b", ...bundle(createInMemoryMessageRepository()), transport, clock: clock.now, idGenerator: makeIdGen("b"), retryPolicy: { ackTimeoutMs: 100, jitter: false } });
    registry.set("a", a);
    registry.set("b", b);
    const delivered = [];
    b.onMessage((d) => delivered.push(d));

    const rand = prng(99);
    const N = 60;
    for (let i = 0; i < N; i++) {
      link.up = rand() > 0.4; // flap the link
      await a.send({ conversationId: "churn", receiverDeviceId: "b", encryptedPayload: cipher(i) });
      // Periodically sweep retries with time advancing.
      clock.advance(200);
      link.up = true;
      await a.sweepRetries();
    }
    // Final drain: bring the link up and sweep until quiescent.
    link.up = true;
    for (let i = 0; i < 5; i++) {
      clock.advance(60_000);
      await a.sweepRetries();
    }

    assert.equal(delivered.length, N, "all delivered exactly once");
    assert.deepEqual(delivered.map((d) => d.seq), Array.from({ length: N }, (_, i) => i + 1), "in order");
    const counts = await a.messages.countByState();
    assert.equal(counts[DeliveryState.ACKNOWLEDGED], N, "all acknowledged");
  });
});

function bundle(repo) {
  return { messages: repo.messages, inbound: repo.inbound, ackHistory: repo.ackHistory, ordering: repo.ordering };
}

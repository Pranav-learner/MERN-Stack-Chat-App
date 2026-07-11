/**
 * High-throughput, concurrency, and fuzz coverage (Layer 8, Sprint 2). Verifies the engine's core
 * guarantees hold at scale + under adversarial loss: every large payload arrives byte-exact, all
 * transfers complete, and nothing deadlocks. Deterministic (seeded PRNG — no Math.random). DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeMesh, fakeCiphertext, runToCompletion } from "./helpers.js";
import { TransferState } from "../types/types.js";

/** mulberry32 — deterministic PRNG. */
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
  it("transports a multi-megabyte payload byte-exact", async () => {
    const mesh = makeMesh({ options: { windowSize: 16, chunkSize: 64 * 1024 } });
    const payload = fakeCiphertext(4 * 1024 * 1024, 123); // 4 MiB → 64 chunks
    const { transfer } = await mesh.engines.alice.startTransfer({ conversationId: "big", receiverDeviceId: "bob", payload, payloadMeta: { kind: "video" } });
    await mesh.net.flush();
    assert.equal(transfer.payloadMeta.totalChunks, 64);
    assert.equal(mesh.received.bob.length, 1);
    assert.ok(Buffer.from(mesh.received.bob[0].payload, "base64").equals(payload), "4 MiB delivered byte-exact");
    assert.equal((await mesh.engines.alice.getTransfer(transfer.transferId)).state, TransferState.COMPLETED);
  });

  it("runs many concurrent transfers across conversations, all intact", async () => {
    const mesh = makeMesh({ options: { windowSize: 8, chunkSize: 32 * 1024, maxConcurrent: 32 } });
    const N = 24;
    const payloads = [];
    for (let i = 0; i < N; i++) {
      const payload = fakeCiphertext((40 + (i % 7) * 30) * 1024, i + 1);
      payloads.push(payload);
      await mesh.engines.alice.startTransfer({ conversationId: `conv-${i % 4}`, receiverDeviceId: "bob", payload, payloadMeta: { kind: i % 2 ? "document" : "file" } });
    }
    await mesh.net.flush();
    assert.equal(mesh.received.bob.length, N, "all transfers delivered");
    for (const payload of payloads) {
      assert.ok(mesh.received.bob.some((p) => Buffer.from(p.payload, "base64").equals(payload)), "each payload intact");
    }
    assert.equal((await mesh.engines.alice.listActiveTransfers()).length, 0);
  });
});

describe("fuzz: adversarial random loss", () => {
  it("recovers every transfer under bounded random chunk loss (many seeds)", async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rand = prng(seed);
      const dropCounts = new Map();
      const mesh = makeMesh({ options: { windowSize: 6, chunkSize: 24 * 1024, chunkAckTimeoutMs: 1000, maxChunkRetries: 8 } });
      // Drop each chunk up to 2 times at random (bounded → guaranteed to converge under retries).
      mesh.net.setDrop((env) => {
        if (env.type !== "chunk") return false;
        const key = env.chunkId;
        const n = dropCounts.get(key) ?? 0;
        if (n < 2 && rand() < 0.35) {
          dropCounts.set(key, n + 1);
          return true;
        }
        return false;
      });

      const payload = fakeCiphertext(300 * 1024, seed);
      const { transfer } = await mesh.engines.alice.startTransfer({ conversationId: "fz", receiverDeviceId: "bob", payload, payloadMeta: { kind: "file" } });
      await runToCompletion(mesh, "alice", { maxRounds: 40, advanceMs: 2000 });

      assert.equal((await mesh.engines.alice.getTransfer(transfer.transferId)).state, TransferState.COMPLETED, `seed ${seed}: completed`);
      assert.equal(mesh.received.bob.length, 1, `seed ${seed}: delivered once`);
      assert.ok(Buffer.from(mesh.received.bob[0].payload, "base64").equals(payload), `seed ${seed}: byte-exact`);
    }
  });
});

describe("stress: mixed concurrent transfers under loss + pause/resume", () => {
  it("eventually delivers everything exactly once", async () => {
    const rand = prng(77);
    const dropCounts = new Map();
    const mesh = makeMesh({ options: { windowSize: 5, chunkSize: 20 * 1024, chunkAckTimeoutMs: 500, maxChunkRetries: 10, maxConcurrent: 16 } });
    mesh.net.setDrop((env) => {
      if (env.type !== "chunk") return false;
      const n = dropCounts.get(env.chunkId) ?? 0;
      if (n < 3 && rand() < 0.25) {
        dropCounts.set(env.chunkId, n + 1);
        return true;
      }
      return false;
    });

    const payloads = [];
    const ids = [];
    for (let i = 0; i < 10; i++) {
      const payload = fakeCiphertext((50 + i * 20) * 1024, i + 100);
      payloads.push(payload);
      const { transfer } = await mesh.engines.alice.startTransfer({ conversationId: `s-${i % 3}`, receiverDeviceId: "bob", payload, payloadMeta: { kind: "file" } });
      ids.push(transfer.transferId);
      if (i === 4) {
        await mesh.engines.alice.pauseTransfer(ids[2]);
        await mesh.engines.alice.resumeTransfer(ids[2]);
      }
    }
    await runToCompletion(mesh, "alice", { maxRounds: 80, advanceMs: 1000 });

    assert.equal(mesh.received.bob.length, 10, "all delivered exactly once");
    for (const payload of payloads) assert.ok(mesh.received.bob.some((p) => Buffer.from(p.payload, "base64").equals(payload)));
    for (const id of ids) assert.equal((await mesh.engines.alice.getTransfer(id)).state, TransferState.COMPLETED);
  });
});

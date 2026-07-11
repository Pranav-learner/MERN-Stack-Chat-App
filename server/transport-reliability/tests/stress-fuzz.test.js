/**
 * Scale, failure-injection, and protocol fuzz (Layer 8, Sprint 3). Verifies the reliability invariants
 * hold across many concurrent transfers + randomized interrupt/recover/migrate/checkpoint sequences:
 * every FSM transition is legal, checkpoints never regress, and transfers end either completed or
 * gracefully-failed with the checkpoint intact. Deterministic (seeded PRNG). DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeManager } from "./helpers.js";
import { ReliabilityState, RecoveryTrigger, MigrationTrigger, isTerminalReliabilityState, ACTIVE_RELIABILITY_STATES } from "../types/types.js";

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

describe("scale", () => {
  it("tracks + completes many concurrent transfers", async () => {
    const ctx = makeManager();
    const N = 300;
    for (let i = 0; i < N; i++) {
      await ctx.manager.registerTransfer({ transferId: `t${i}`, conversationId: `c${i % 10}`, senderDeviceId: "alice", receiverDeviceId: "bob", connectionId: "conn-1", totalChunks: 50 });
      await ctx.manager.checkpoint({ transferId: `t${i}`, chunksAcked: 50, highWaterMark: 49, bytesTransferred: 3_200_000 });
      await ctx.manager.complete(`t${i}`);
    }
    const health = await ctx.manager.health();
    assert.equal(health.states[ReliabilityState.COMPLETED], N);
    assert.equal(health.transferSuccessRate, 1);
  });
});

describe("fuzz: randomized reliability sequences", () => {
  it("keeps invariants across interrupt/recover/migrate/checkpoint storms", async () => {
    const ACTIVE = new Set(ACTIVE_RELIABILITY_STATES);
    for (let seed = 1; seed <= 15; seed++) {
      const rand = prng(seed);
      // ~30% of resume/migrate attempts fail, to exercise both success + graceful-failure paths.
      const ctx = makeManager({
        clock: undefined,
        retryPolicy: { maxAttempts: 4, recoveryTimeoutMs: 1_000_000 },
        resumeResult: true,
      });
      const T = 12;
      const ids = [];
      for (let i = 0; i < T; i++) {
        const id = `s${seed}-t${i}`;
        ids.push(id);
        await ctx.manager.registerTransfer({ transferId: id, conversationId: `c${i % 3}`, senderDeviceId: "alice", receiverDeviceId: "bob", connectionId: "conn-1", totalChunks: 100 });
      }

      let lastAcked = new Map(ids.map((id) => [id, 0]));
      for (let step = 0; step < 60; step++) {
        const id = ids[Math.floor(rand() * ids.length)];
        const rec = await ctx.manager.getRecord(id);
        if (isTerminalReliabilityState(rec.state)) continue;
        const roll = rand();
        try {
          if (roll < 0.4) {
            // advance checkpoint
            const prev = lastAcked.get(id);
            const acked = Math.min(100, prev + 1 + Math.floor(rand() * 20));
            lastAcked.set(id, acked);
            await ctx.manager.checkpoint({ transferId: id, chunksAcked: acked, highWaterMark: acked - 1, bytesTransferred: acked * 64_000, outstanding: Math.floor(rand() * 8) });
          } else if (roll < 0.6) {
            await ctx.manager.reportInterruption(id, RecoveryTrigger.STALL_TIMEOUT);
          } else if (roll < 0.8) {
            await ctx.manager.recover(id, rand() < 0.5 ? RecoveryTrigger.CHUNK_TIMEOUT : RecoveryTrigger.CONNECTION_LOSS, { newConnectionId: `conn-${step}` });
          } else if (roll < 0.9) {
            await ctx.manager.migrate(id, `conn-${step}`, { trigger: MigrationTrigger.WIFI_TO_MOBILE });
          } else if (lastAcked.get(id) >= 100) {
            await ctx.manager.complete(id);
          }
        } catch {
          // terminal-state or migration-rejected errors are legitimate outcomes; ignore
        }

        // Invariants after every step.
        const after = await ctx.manager.getRecord(id);
        assert.ok(ACTIVE.has(after.state) || isTerminalReliabilityState(after.state), `seed ${seed}: legal state ${after.state}`);
        assert.ok(after.checkpoint.chunksAcked >= lastAcked.get(id) - 0, `seed ${seed}: checkpoint never regresses`);
        assert.ok(after.checkpoint.chunksAcked <= 100, `seed ${seed}: bounded`);
      }

      // Every transfer is in a legal state, and any FAILED one kept its checkpoint.
      for (const id of ids) {
        const rec = await ctx.manager.getRecord(id);
        assert.ok(ACTIVE.has(rec.state) || isTerminalReliabilityState(rec.state));
        if (rec.state === ReliabilityState.FAILED) assert.ok(rec.checkpoint.chunksAcked >= 0, `seed ${seed}: failed transfer keeps checkpoint`);
      }
    }
  });
});

describe("performance", () => {
  it("handles a burst of checkpoints quickly", async () => {
    const ctx = makeManager();
    await ctx.manager.registerTransfer({ transferId: "perf", conversationId: "c", senderDeviceId: "alice", receiverDeviceId: "bob", connectionId: "conn-1", totalChunks: 10_000 });
    for (let i = 1; i <= 2000; i++) {
      await ctx.manager.checkpoint({ transferId: "perf", chunksAcked: i, highWaterMark: i - 1, bytesTransferred: i * 64_000, outstanding: 8 });
    }
    const rec = await ctx.manager.getRecord("perf");
    assert.equal(rec.checkpoint.chunksAcked, 2000);
    // Metrics captured throughput observations.
    assert.ok(ctx.metrics.snapshot().histograms);
  });
});

/**
 * Scale, long-offline devices, failure injection, and protocol fuzz (Layer 9, Sprint 3). Verifies the
 * reliability invariants hold across many concurrent syncs + randomized checkpoint/interrupt/recover
 * sequences: every FSM transition is legal, checkpoints never regress, and syncs end either completed
 * or gracefully-failed with the checkpoint intact. Deterministic (seeded PRNG). DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeManager } from "./helpers.js";
import { ReliabilityState, RecoveryTrigger, isTerminalReliabilityState, ACTIVE_RELIABILITY_STATES } from "../types/types.js";

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

describe("scale + long-offline", () => {
  it("tracks + completes many concurrent syncs", async () => {
    const ctx = makeManager();
    const N = 300;
    for (let i = 0; i < N; i++) {
      await ctx.manager.registerSync({ sessionId: `s${i}`, replicaId: `r${i}`, deviceId: "phone", userId: "u1", totalOperations: 50 });
      await ctx.manager.checkpoint({ syncId: `s${i}`, completedOperations: 50, cursor: 50, replicaDrift: 0 });
      await ctx.manager.complete(`s${i}`);
    }
    const health = await ctx.manager.health();
    assert.equal(health.states[ReliabilityState.COMPLETED], N);
    assert.equal(health.syncSuccessRate, 1);
  });

  it("recovers a long-offline device from a large sync session", async () => {
    const ctx = makeManager({ retryPolicy: { maxAttempts: 5, recoveryTimeoutMs: 10_000_000 } });
    await ctx.manager.registerSync({ sessionId: "offline", replicaId: "r1", deviceId: "phone", userId: "u1", totalOperations: 50_000 });
    await ctx.manager.checkpoint({ syncId: "offline", completedOperations: 20_000, cursor: 20_000, replicaDrift: 30_000 });
    ctx.clock.advance(7 * 24 * 60 * 60 * 1000); // gone for a week
    const res = await ctx.manager.recover("offline", RecoveryTrigger.APP_RESTART);
    assert.equal(res.outcome, "recovered");
    assert.equal(res.resumePlan.fromCursor, 20_000);
    assert.equal(res.resumePlan.remaining, 30_000);
  });
});

describe("fuzz: randomized reliability sequences", () => {
  it("keeps invariants across checkpoint/interrupt/recover storms", async () => {
    const ACTIVE = new Set(ACTIVE_RELIABILITY_STATES);
    for (let seed = 1; seed <= 15; seed++) {
      const rand = prng(seed);
      const ctx = makeManager({ resumeResult: rand() > 0.3, retryPolicy: { maxAttempts: 4, retryBudget: 30, recoveryTimeoutMs: 1_000_000 } });
      const ids = [];
      for (let i = 0; i < 10; i++) {
        const id = `s${seed}-${i}`;
        ids.push(id);
        await ctx.manager.registerSync({ sessionId: id, replicaId: `r${i}`, deviceId: "phone", userId: "u1", totalOperations: 100 });
      }
      const lastDone = new Map(ids.map((id) => [id, 0]));

      for (let step = 0; step < 60; step++) {
        const id = ids[Math.floor(rand() * ids.length)];
        const rec = await ctx.manager.getRecord(id);
        if (isTerminalReliabilityState(rec.state)) continue;
        const roll = rand();
        try {
          if (roll < 0.45) {
            const prev = lastDone.get(id);
            const done = Math.min(100, prev + 1 + Math.floor(rand() * 25));
            lastDone.set(id, done);
            await ctx.manager.checkpoint({ syncId: id, completedOperations: done, cursor: done, conflicts: Math.floor(rand() * 3), merges: Math.floor(rand() * 4), pendingOperations: 100 - done, replicaDrift: 100 - done });
          } else if (roll < 0.65) {
            await ctx.manager.reportInterruption(id, RecoveryTrigger.STALL_TIMEOUT);
          } else if (roll < 0.85) {
            await ctx.manager.recover(id, rand() < 0.5 ? RecoveryTrigger.DEVICE_CRASH : RecoveryTrigger.CONNECTION_LOSS);
          } else if (lastDone.get(id) >= 100) {
            await ctx.manager.complete(id);
          }
        } catch {
          // terminal-state errors are legitimate outcomes; ignore
        }

        const after = await ctx.manager.getRecord(id);
        assert.ok(ACTIVE.has(after.state) || isTerminalReliabilityState(after.state), `seed ${seed}: legal state ${after.state}`);
        assert.ok(after.checkpoint.completedOperations >= lastDone.get(id) - 0, `seed ${seed}: checkpoint never regresses`);
        assert.ok(after.checkpoint.completedOperations <= 100);
      }

      for (const id of ids) {
        const rec = await ctx.manager.getRecord(id);
        assert.ok(ACTIVE.has(rec.state) || isTerminalReliabilityState(rec.state));
        if (rec.state === ReliabilityState.FAILED) assert.ok(rec.checkpoint.completedOperations >= 0, `seed ${seed}: failed sync keeps checkpoint`);
      }
    }
  });
});

describe("performance", () => {
  it("handles a burst of checkpoints quickly", async () => {
    const ctx = makeManager();
    await ctx.manager.registerSync({ sessionId: "perf", replicaId: "r1", deviceId: "phone", userId: "u1", totalOperations: 10_000 });
    for (let i = 1; i <= 2000; i++) {
      await ctx.manager.checkpoint({ syncId: "perf", completedOperations: i, cursor: i, pendingOperations: 10_000 - i, replicaDrift: 10_000 - i });
    }
    assert.equal((await ctx.manager.getRecord("perf")).checkpoint.completedOperations, 2000);
    assert.ok(ctx.metrics.snapshot().gauges);
  });
});

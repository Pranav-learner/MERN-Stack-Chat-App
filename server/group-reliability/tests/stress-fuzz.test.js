/**
 * Stress + failure-injection + fuzz (Layer 10, Sprint 3): large groups, concurrent operations, massive
 * fan-out checkpoints, key rotation under load, replica/offline recovery, and protocol-message fuzzing.
 * DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeManager, makeClock, makeIdGen } from "./helpers.js";
import { ReliabilityState, RecoveryTrigger, GroupOperationType, ALL_OPERATION_TYPES, ALL_RECOVERY_TRIGGERS } from "../types/types.js";
import { advanceCheckpoint } from "../recovery/checkpoint.js";
import { scoreHealth } from "../health/healthMonitor.js";

describe("large group + massive fan-out", () => {
  it("checkpoints a 5000-target fan-out monotonically to completion", async () => {
    const ctx = makeManager();
    await ctx.manager.registerOperation({ operationId: "big", groupId: "g", operationType: "fan-out", deviceId: "alice", totalTargets: 5000 });
    for (let done = 500; done <= 5000; done += 500) {
      ctx.clock.advance(100);
      await ctx.manager.checkpoint({ operationId: "big", completedTargets: done, cursor: done, pendingTargets: 5000 - done });
    }
    const rec = await ctx.manager.complete("big");
    assert.equal(rec.state, ReliabilityState.COMPLETED);
    assert.equal(rec.checkpoint.completedTargets, 5000);
    assert.equal(rec.checkpoint.pendingTargets, 0);
  });

  it("out-of-order checkpoints never rewind progress", async () => {
    const ctx = makeManager();
    await ctx.manager.registerOperation({ operationId: "ooo", groupId: "g", operationType: "fan-out", deviceId: "alice", totalTargets: 100 });
    await ctx.manager.checkpoint({ operationId: "ooo", completedTargets: 80, cursor: 80 });
    await ctx.manager.checkpoint({ operationId: "ooo", completedTargets: 30, cursor: 30 }); // stale/reordered
    const rec = await ctx.manager.getRecord("ooo");
    assert.equal(rec.checkpoint.completedTargets, 80, "monotonic — no rewind");
  });
});

describe("concurrent operations", () => {
  it("tracks many concurrent group operations without loss", async () => {
    const ctx = makeManager();
    const N = 100;
    await Promise.all(Array.from({ length: N }, (_, i) => ctx.manager.registerOperation({ operationId: `op:${i}`, groupId: `g${i % 5}`, operationType: ALL_OPERATION_TYPES[i % ALL_OPERATION_TYPES.length], deviceId: `d${i}`, totalTargets: 10 })));
    const active = await ctx.manager.listOperations();
    assert.equal(active.length, N);
    // concurrent checkpoints + completes
    await Promise.all(Array.from({ length: N }, (_, i) => ctx.manager.checkpoint({ operationId: `op:${i}`, completedTargets: 10, cursor: 10, pendingTargets: 0 }).then(() => ctx.manager.complete(`op:${i}`))));
    const counts = await ctx.repo.records.countByState();
    assert.equal(counts.completed, N);
  });

  it("key rotation under load — many rekey operations recover independently", async () => {
    const ctx = makeManager();
    const N = 50;
    await Promise.all(Array.from({ length: N }, (_, i) => ctx.manager.registerOperation({ operationId: `rk:${i}`, groupId: "g", operationType: GroupOperationType.REKEY, deviceId: "server", totalTargets: 3, keyVersion: i + 1 })));
    const recovered = await Promise.all(Array.from({ length: N }, (_, i) => ctx.manager.recover(`rk:${i}`, RecoveryTrigger.REKEY_FAILURE)));
    assert.ok(recovered.every((r) => r.record.state === ReliabilityState.TRACKING));
    const snap = ctx.api.metrics();
    assert.equal(snap.counters.group_key_rotation_total, N);
  });
});

describe("failure injection + replica/offline recovery", () => {
  it("recovers a replica-sync + an offline-delivery from checkpoint", async () => {
    for (const [type, trigger] of [["replica-sync", RecoveryTrigger.REPLICA_FAILURE], ["offline-delivery", RecoveryTrigger.OFFLINE_INTERRUPTION]]) {
      const ctx = makeManager();
      await ctx.manager.registerOperation({ operationId: "op", groupId: "g", operationType: type, deviceId: "alice", totalTargets: 20 });
      await ctx.manager.checkpoint({ operationId: "op", completedTargets: 12, cursor: 12, pendingTargets: 8 });
      const r = await ctx.manager.recover("op", trigger);
      assert.equal(r.record.state, ReliabilityState.TRACKING, `${type} recovers`);
      assert.equal(r.resumePlan.remaining, 8);
    }
  });

  it("a hook that always fails leads to graceful terminal failure with checkpoint intact", async () => {
    const ctx = makeManager({ retryPolicy: { maxAttempts: 3, retryBudget: 3, recoveryTimeoutMs: 1 }, recoveryHooks: { resumeFromCheckpoint: async () => false } });
    await ctx.manager.registerOperation({ operationId: "op", groupId: "g", operationType: "fan-out", deviceId: "alice", totalTargets: 10 });
    await ctx.manager.checkpoint({ operationId: "op", completedTargets: 6, cursor: 6 });
    await ctx.manager.reportInterruption("op", RecoveryTrigger.FAILED_FANOUT); // stamps recoveringSince
    ctx.clock.advance(10); // exceed the 1ms recovery timeout
    const r = await ctx.manager.recover("op", RecoveryTrigger.FAILED_FANOUT);
    assert.equal(r.record.state, ReliabilityState.FAILED);
    assert.equal(r.record.checkpoint.cursor, 6, "checkpoint preserved");
  });
});

describe("fuzz — group protocol messages", () => {
  it("register + checkpoint tolerate randomized (bounded) inputs without corruption", async () => {
    const clock = makeClock();
    const idGen = makeIdGen();
    const ctx = makeManager({ clock, idGen });
    // deterministic PRNG (no Math.random → reproducible)
    let seed = 12345;
    const rand = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let i = 0; i < 300; i++) {
      const operationId = `f:${i}`;
      const total = rand(1000) + 1;
      await ctx.manager.registerOperation({ operationId, groupId: `g${rand(10)}`, operationType: ALL_OPERATION_TYPES[rand(ALL_OPERATION_TYPES.length)], deviceId: `d${rand(20)}`, totalTargets: total });
      // a burst of random (valid, non-negative) checkpoints
      let hi = 0;
      for (let j = 0; j < 5; j++) {
        const completed = rand(total + 1);
        clock.advance(rand(100));
        const rec = await ctx.manager.checkpoint({ operationId, completedTargets: completed, cursor: completed, failedTargets: rand(10), pendingTargets: rand(total + 1) });
        hi = Math.max(hi, completed);
        // invariant: monotonic completedTargets, valid health score in [0,1]
        assert.ok(rec.checkpoint.completedTargets >= hi - 0 && rec.checkpoint.completedTargets <= total);
        const health = scoreHealth(rec, { now: clock.now() });
        assert.ok(health.score >= 0 && health.score <= 1, `health score in range (${health.score})`);
        assert.ok([ReliabilityState.TRACKING, ReliabilityState.DEGRADED].includes(rec.state));
      }
    }
  });

  it("rejects malformed checkpoints (negative / non-finite) without mutating state", async () => {
    const ctx = makeManager();
    await ctx.manager.registerOperation({ operationId: "op", groupId: "g", operationType: "fan-out", deviceId: "d", totalTargets: 10 });
    await ctx.manager.checkpoint({ operationId: "op", completedTargets: 5, cursor: 5 });
    for (const bad of [{ completedTargets: -1 }, { cursor: NaN }, { failedTargets: -5 }, { pendingTargets: Infinity }]) {
      await assert.rejects(() => ctx.manager.checkpoint({ operationId: "op", ...bad }), /invalid/i);
    }
    assert.equal((await ctx.manager.getRecord("op")).checkpoint.completedTargets, 5, "state unchanged after rejected updates");
  });

  it("every operation type + recovery trigger combination is handled", async () => {
    for (const type of ALL_OPERATION_TYPES) {
      for (const trigger of ALL_RECOVERY_TRIGGERS) {
        const ctx = makeManager();
        await ctx.manager.registerOperation({ operationId: "op", groupId: "g", operationType: type, deviceId: "d", totalTargets: 5 });
        const r = await ctx.manager.recover("op", trigger);
        assert.ok(["recovered", "failed", "exhausted"].includes(r.outcome), `${type}/${trigger} → ${r.outcome}`);
      }
    }
  });
});

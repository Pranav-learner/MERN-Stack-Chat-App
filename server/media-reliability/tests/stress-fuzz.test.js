/**
 * Stress + failure-injection + fuzz (Layer 11, Sprint 3): very large files (10GB), concurrent
 * uploads/downloads, storage-failure recovery, streaming recovery, and media-protocol fuzzing. DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeManager, makeClock, makeIdGen } from "./helpers.js";
import { ReliabilityState, RecoveryTrigger, MediaOperationType, ALL_OPERATION_TYPES, ALL_RECOVERY_TRIGGERS } from "../types/types.js";
import { scoreHealth } from "../health/healthMonitor.js";

describe("very large files", () => {
  it("checkpoints a 10GB / 40000-chunk upload monotonically to completion", async () => {
    const ctx = makeManager();
    const bytesTotal = 10 * 1024 * 1024 * 1024;
    const totalChunks = 40_000;
    await ctx.manager.registerOperation({ operationId: "big", mediaId: "m", operationType: "upload", deviceId: "alice", totalChunks, bytesTotal });
    for (let done = 5_000; done <= 40_000; done += 5_000) {
      ctx.clock.advance(1000);
      await ctx.manager.checkpoint({ operationId: "big", completedChunks: done, cursor: done, pendingChunks: totalChunks - done, bytesTransferred: Math.round((done / totalChunks) * bytesTotal) });
    }
    const rec = await ctx.manager.complete("big");
    assert.equal(rec.state, ReliabilityState.COMPLETED);
    assert.equal(rec.checkpoint.completedChunks, 40_000);
    assert.equal(rec.checkpoint.pendingChunks, 0);
  });

  it("out-of-order checkpoints never rewind progress", async () => {
    const ctx = makeManager();
    await ctx.manager.registerOperation({ operationId: "ooo", mediaId: "m", operationType: "download", deviceId: "d", totalChunks: 100, bytesTotal: 1000 });
    await ctx.manager.checkpoint({ operationId: "ooo", completedChunks: 80, cursor: 80, bytesTransferred: 800 });
    await ctx.manager.checkpoint({ operationId: "ooo", completedChunks: 30, cursor: 30, bytesTransferred: 300 });
    const rec = await ctx.manager.getRecord("ooo");
    assert.equal(rec.checkpoint.completedChunks, 80);
    assert.equal(rec.checkpoint.bytesTransferred, 800);
  });
});

describe("concurrency", () => {
  it("tracks many concurrent media operations without loss", async () => {
    const ctx = makeManager();
    const N = 100;
    await Promise.all(Array.from({ length: N }, (_, i) => ctx.manager.registerOperation({ operationId: `op:${i}`, mediaId: `m${i % 5}`, operationType: ALL_OPERATION_TYPES[i % ALL_OPERATION_TYPES.length], deviceId: `d${i}`, totalChunks: 10, bytesTotal: 1000 })));
    assert.equal((await ctx.manager.listOperations()).length, N);
    await Promise.all(Array.from({ length: N }, (_, i) => ctx.manager.checkpoint({ operationId: `op:${i}`, completedChunks: 10, cursor: 10, pendingChunks: 0 }).then(() => ctx.manager.complete(`op:${i}`))));
    assert.equal((await ctx.repo.records.countByState()).completed, N);
  });

  it("concurrent uploads + downloads recover independently", async () => {
    const ctx = makeManager();
    const N = 40;
    await Promise.all(Array.from({ length: N }, (_, i) => ctx.manager.registerOperation({ operationId: `t:${i}`, mediaId: "m", operationType: i % 2 ? MediaOperationType.UPLOAD : MediaOperationType.DOWNLOAD, deviceId: "server", totalChunks: 5, bytesTotal: 500 })));
    const recovered = await Promise.all(Array.from({ length: N }, (_, i) => ctx.manager.recover(`t:${i}`, i % 2 ? RecoveryTrigger.INTERRUPTED_UPLOAD : RecoveryTrigger.INTERRUPTED_DOWNLOAD)));
    assert.ok(recovered.every((r) => r.record.state === ReliabilityState.TRACKING));
  });
});

describe("failure injection", () => {
  it("recovers a streaming failure + a storage failure from checkpoint", async () => {
    for (const [type, trigger] of [["streaming", RecoveryTrigger.STREAMING_FAILURE], ["pipeline", RecoveryTrigger.STORAGE_FAILURE]]) {
      const ctx = makeManager();
      await ctx.manager.registerOperation({ operationId: "op", mediaId: "m", operationType: type, deviceId: "alice", totalChunks: 20, bytesTotal: 2000 });
      await ctx.manager.checkpoint({ operationId: "op", completedChunks: 12, cursor: 12, pendingChunks: 8, bytesTransferred: 1200 });
      const r = await ctx.manager.recover("op", trigger);
      assert.equal(r.record.state, ReliabilityState.TRACKING, `${type} recovers`);
      assert.equal(r.resumePlan.remaining, 8);
    }
  });

  it("a hook that always fails leads to graceful terminal failure with checkpoint intact", async () => {
    const ctx = makeManager({ retryPolicy: { maxAttempts: 3, retryBudget: 3, recoveryTimeoutMs: 1 }, recoveryHooks: { resumeFromCheckpoint: async () => false } });
    await ctx.manager.registerOperation({ operationId: "op", mediaId: "m", operationType: "upload", deviceId: "alice", totalChunks: 10, bytesTotal: 1000 });
    await ctx.manager.checkpoint({ operationId: "op", completedChunks: 6, cursor: 6, bytesTransferred: 600 });
    await ctx.manager.reportInterruption("op", RecoveryTrigger.INTERRUPTED_UPLOAD);
    ctx.clock.advance(10);
    const r = await ctx.manager.recover("op", RecoveryTrigger.INTERRUPTED_UPLOAD);
    assert.equal(r.record.state, ReliabilityState.FAILED);
    assert.equal(r.record.checkpoint.cursor, 6, "checkpoint preserved");
  });
});

describe("fuzz — media protocol messages", () => {
  it("register + checkpoint tolerate randomized (bounded) inputs without corruption", async () => {
    const clock = makeClock();
    const ctx = makeManager({ clock, idGen: makeIdGen() });
    let seed = 987654;
    const rand = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let i = 0; i < 250; i++) {
      const operationId = `f:${i}`;
      const total = rand(50_000) + 1;
      const bytesTotal = rand(1_000_000_000) + 1;
      await ctx.manager.registerOperation({ operationId, mediaId: `m${rand(10)}`, operationType: ALL_OPERATION_TYPES[rand(ALL_OPERATION_TYPES.length)], deviceId: `d${rand(20)}`, totalChunks: total, bytesTotal });
      let hi = 0;
      for (let j = 0; j < 4; j++) {
        const completed = rand(total + 1);
        clock.advance(rand(500));
        const rec = await ctx.manager.checkpoint({ operationId, completedChunks: completed, cursor: completed, failedChunks: rand(20), pendingChunks: rand(total + 1), bytesTransferred: rand(bytesTotal + 1) });
        hi = Math.max(hi, completed);
        assert.ok(rec.checkpoint.completedChunks >= hi - 0 && rec.checkpoint.completedChunks <= total);
        const health = scoreHealth(rec, { now: clock.now() });
        assert.ok(health.score >= 0 && health.score <= 1);
        assert.ok([ReliabilityState.TRACKING, ReliabilityState.DEGRADED].includes(rec.state));
      }
    }
  });

  it("rejects malformed checkpoints (negative / non-finite) without mutating state", async () => {
    const ctx = makeManager();
    await ctx.manager.registerOperation({ operationId: "op", mediaId: "m", operationType: "upload", deviceId: "d", totalChunks: 10, bytesTotal: 1000 });
    await ctx.manager.checkpoint({ operationId: "op", completedChunks: 5, cursor: 5 });
    for (const bad of [{ completedChunks: -1 }, { cursor: NaN }, { failedChunks: -5 }, { bytesTransferred: Infinity }]) {
      await assert.rejects(() => ctx.manager.checkpoint({ operationId: "op", ...bad }), /invalid/i);
    }
    assert.equal((await ctx.manager.getRecord("op")).checkpoint.completedChunks, 5);
  });

  it("every operation type + recovery trigger combination is handled", async () => {
    for (const type of ALL_OPERATION_TYPES) {
      for (const trigger of ALL_RECOVERY_TRIGGERS) {
        const ctx = makeManager();
        await ctx.manager.registerOperation({ operationId: "op", mediaId: "m", operationType: type, deviceId: "d", totalChunks: 5, bytesTotal: 500 });
        const r = await ctx.manager.recover("op", trigger);
        assert.ok(["recovered", "failed", "exhausted"].includes(r.outcome), `${type}/${trigger} → ${r.outcome}`);
      }
    }
  });
});

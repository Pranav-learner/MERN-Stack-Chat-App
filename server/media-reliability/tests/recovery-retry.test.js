/**
 * Recovery engine + retry policies (Layer 11, Sprint 3): every recovery trigger, checkpoint-preserving
 * resume, bounded attempts + retry budget + timeout, graceful failure. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, seedOperation, countEvents } from "./helpers.js";
import { ReliabilityState, RecoveryTrigger, RecoveryOutcome, RecoveryAction, ReliabilityEventType, RECOVERY_PLANS } from "../types/types.js";
import { advanceCheckpoint, planResume } from "../recovery/checkpoint.js";
import { computeBackoff, shouldRetry, withinBudget, resolveRetryPolicy } from "../retry/retryPolicy.js";
import { RecoveryCoordinator } from "../recovery/recoveryCoordinator.js";

describe("media checkpoint (pure)", () => {
  it("advances monotonically (chunks + bytes) + never rewinds", () => {
    let cp = advanceCheckpoint(null, { totalChunks: 40, completedChunks: 10, cursor: 10, bytesTotal: 10_000_000, bytesTransferred: 2_500_000 });
    cp = advanceCheckpoint(cp, { completedChunks: 25, cursor: 25, bytesTransferred: 6_000_000 });
    assert.equal(cp.completedChunks, 25);
    assert.equal(cp.bytesTransferred, 6_000_000);
    const late = advanceCheckpoint(cp, { completedChunks: 15, cursor: 15, bytesTransferred: 3_000_000 });
    assert.equal(late.completedChunks, 25, "cannot rewind chunks");
    assert.equal(late.bytesTransferred, 6_000_000, "cannot rewind bytes");
  });

  it("planResume computes remaining chunks + bytes", () => {
    const plan = planResume({ totalChunks: 40, cursor: 25, bytesTotal: 10_000_000, bytesTransferred: 6_250_000 });
    assert.equal(plan.resumable, true);
    assert.equal(plan.fromCursor, 25);
    assert.equal(plan.remaining, 15);
    assert.equal(plan.bytesRemaining, 3_750_000);
    assert.equal(planResume({ totalChunks: 40, cursor: 40 }).resumable, false);
  });
});

describe("retry policy (pure)", () => {
  it("exponential backoff grows + is capped; budget + attempts bound retries", () => {
    const p = resolveRetryPolicy({ baseDelayMs: 100, factor: 2, maxDelayMs: 1000, jitter: false });
    assert.equal(computeBackoff(1, p), 100);
    assert.equal(computeBackoff(10, p), 1000, "capped");
    assert.ok(shouldRetry(2, { maxAttempts: 5 }));
    assert.ok(!shouldRetry(5, { maxAttempts: 5 }));
    assert.ok(!withinBudget(25, { retryBudget: 25 }));
  });
});

describe("recovery coordinator (pure)", () => {
  it("maps media triggers to actions", () => {
    const c = new RecoveryCoordinator();
    assert.equal(c.resolvePlan(RecoveryTrigger.INTERRUPTED_UPLOAD).action, RecoveryAction.RESUME_FROM_CHECKPOINT);
    assert.equal(c.resolvePlan(RecoveryTrigger.STORAGE_FAILURE).action, RecoveryAction.RETRY);
    assert.equal(c.resolvePlan(RecoveryTrigger.PIPELINE_FAILURE).action, RecoveryAction.REPLAN);
    for (const plan of Object.values(RECOVERY_PLANS)) assert.equal(plan.recoverable, true);
  });
});

describe("recovery through the manager", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("recovers an interrupted upload from its checkpoint (preserving bytes)", async () => {
    await seedOperation(ctx.manager, { totalChunks: 40, bytesTotal: 10_000_000 });
    await ctx.manager.checkpoint({ operationId: "op:1", completedChunks: 20, cursor: 20, failedChunks: 2, pendingChunks: 20, bytesTransferred: 5_000_000 });
    const r = await ctx.manager.recover("op:1", RecoveryTrigger.INTERRUPTED_UPLOAD);
    assert.equal(r.outcome, RecoveryOutcome.RECOVERED);
    assert.equal(r.record.state, ReliabilityState.TRACKING);
    assert.equal(r.resumePlan.fromCursor, 20);
    assert.equal(r.resumePlan.remaining, 20);
    assert.equal(r.resumePlan.bytesRemaining, 5_000_000);
    assert.equal(countEvents(ctx.captured, ReliabilityEventType.RECOVERY_SUCCEEDED), 1);
  });

  it("auto-recovers on reported interruption", async () => {
    await seedOperation(ctx.manager);
    const rec = await ctx.manager.reportInterruption("op:1", RecoveryTrigger.CONNECTION_LOSS, { autoRecover: true });
    assert.equal(rec.record?.state ?? rec.state, ReliabilityState.TRACKING);
  });

  it("graceful-fails when the retry budget is exhausted, keeping the checkpoint intact", async () => {
    const ctx2 = makeManager({ retryPolicy: { maxAttempts: 2, retryBudget: 2 }, recoveryHooks: { resumeFromCheckpoint: async () => false, retry: async () => false, replan: async () => false } });
    await seedOperation(ctx2.manager, { totalChunks: 10, bytesTotal: 1000 });
    await ctx2.manager.checkpoint({ operationId: "op:1", completedChunks: 4, cursor: 4, bytesTransferred: 400 });
    let last;
    for (let i = 0; i < 5; i++) {
      last = await ctx2.manager.recover("op:1", RecoveryTrigger.INTERRUPTED_DOWNLOAD).catch((e) => ({ error: e }));
      if (last?.record?.state === ReliabilityState.FAILED) break;
    }
    const rec = await ctx2.manager.getRecord("op:1");
    assert.equal(rec.state, ReliabilityState.FAILED);
    assert.equal(rec.checkpoint.cursor, 4, "checkpoint preserved (resumable later)");
    assert.equal(countEvents(ctx2.captured, ReliabilityEventType.OPERATION_FAILED), 1);
  });

  it("cannot recover/resume a terminal operation", async () => {
    await seedOperation(ctx.manager);
    await ctx.manager.checkpoint({ operationId: "op:1", completedChunks: 40, cursor: 40, pendingChunks: 0 });
    await ctx.manager.complete("op:1");
    await assert.rejects(() => ctx.manager.recover("op:1", RecoveryTrigger.INTERRUPTED_UPLOAD), /Cannot recover/i);
    await assert.rejects(() => ctx.manager.resume("op:1"), /Cannot resume/i);
  });

  it("handles all recovery triggers", async () => {
    for (const trigger of Object.values(RecoveryTrigger)) {
      const c = makeManager();
      await seedOperation(c.manager, { operationId: `op:${trigger}` });
      const r = await c.manager.recover(`op:${trigger}`, trigger);
      assert.equal(r.outcome, RecoveryOutcome.RECOVERED, `trigger ${trigger} recovers with default optimistic hook`);
    }
  });
});

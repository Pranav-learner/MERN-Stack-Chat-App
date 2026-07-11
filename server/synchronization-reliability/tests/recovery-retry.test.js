/**
 * Recovery + retry policies (Layer 9, Sprint 3): resume-from-checkpoint, checkpoint monotonicity,
 * recovery timeout, bounded attempts + retry budget → graceful failure (state preserved), and the
 * retry-policy math. DB-free, deterministic clock.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, seedSync, countEvents } from "./helpers.js";
import { advanceCheckpoint, planResume } from "../recovery/checkpoint.js";
import { RecoveryCoordinator } from "../recovery/recoveryCoordinator.js";
import { computeBackoff, shouldRetry, withinBudget, resolveRetryPolicy } from "../retry/retryPolicy.js";
import { ReliabilityState, RecoveryTrigger, RecoveryAction, RecoveryOutcome, ReliabilityEventType, RetryStrategy } from "../types/types.js";

describe("checkpoint (pure)", () => {
  it("advances monotonically (never regresses)", () => {
    const a = advanceCheckpoint(null, { totalOperations: 100, completedOperations: 40, cursor: 40 });
    const b = advanceCheckpoint(a, { completedOperations: 20, cursor: 10 }); // stale
    assert.equal(b.completedOperations, 40);
    assert.equal(b.cursor, 40);
  });

  it("plans a resume from the cursor", () => {
    const plan = planResume({ totalOperations: 100, cursor: 40 });
    assert.equal(plan.fromCursor, 40);
    assert.equal(plan.remaining, 60);
    assert.equal(plan.resumable, true);
    assert.equal(planResume({ totalOperations: 10, cursor: 10 }).resumable, false);
  });
});

describe("retry policy (pure)", () => {
  it("computes backoff per strategy", () => {
    assert.equal(computeBackoff(3, { strategy: RetryStrategy.IMMEDIATE }), 0);
    assert.equal(computeBackoff(3, { strategy: RetryStrategy.FIXED, baseDelayMs: 500 }), 500);
    assert.equal(computeBackoff(1, { strategy: RetryStrategy.EXPONENTIAL_BACKOFF, baseDelayMs: 100, factor: 2, jitter: false }), 100);
    assert.equal(computeBackoff(3, { strategy: RetryStrategy.EXPONENTIAL_BACKOFF, baseDelayMs: 100, factor: 2, jitter: false }), 400);
    assert.equal(computeBackoff(5, { strategy: RetryStrategy.NONE }), Infinity);
  });

  it("bounds attempts + lifetime budget", () => {
    assert.equal(shouldRetry(2, { maxAttempts: 3 }), true);
    assert.equal(shouldRetry(3, { maxAttempts: 3 }), false);
    assert.equal(shouldRetry(0, { strategy: RetryStrategy.NONE }), false);
    assert.equal(withinBudget(19, { retryBudget: 20 }), true);
    assert.equal(withinBudget(20, { retryBudget: 20 }), false);
    assert.equal(resolveRetryPolicy().maxAttempts, 5);
  });
});

describe("recovery coordinator (pure)", () => {
  it("maps triggers to actions", () => {
    const c = new RecoveryCoordinator();
    assert.equal(c.resolvePlan(RecoveryTrigger.DEVICE_CRASH).action, RecoveryAction.RESUME_FROM_CHECKPOINT);
    assert.equal(c.resolvePlan(RecoveryTrigger.CONNECTION_LOSS).action, RecoveryAction.RETRY);
    assert.equal(c.resolvePlan(RecoveryTrigger.REPOSITORY_FAILURE).action, RecoveryAction.RESTART);
  });
});

describe("manager recovery", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("recovers by resuming from the checkpoint", async () => {
    const id = await seedSync(ctx.manager);
    const res = await ctx.manager.recover(id, RecoveryTrigger.DEVICE_CRASH);
    assert.equal(res.outcome, RecoveryOutcome.RECOVERED);
    assert.equal(res.record.state, ReliabilityState.TRACKING);
    assert.equal(ctx.calls.resume[0].plan.fromCursor, 40);
    assert.equal(res.record.resumeCount, 1);
    assert.equal(countEvents(ctx.captured, ReliabilityEventType.RECOVERY_SUCCEEDED), 1);
    assert.equal(countEvents(ctx.captured, ReliabilityEventType.SYNC_RESUMED), 1);
  });

  it("connection-loss uses retry; app-restart resumes", async () => {
    const id = await seedSync(ctx.manager);
    await ctx.manager.recover(id, RecoveryTrigger.CONNECTION_LOSS);
    assert.equal(ctx.calls.retry.length, 1);
    const id2 = await seedSync(ctx.manager, { sessionId: "s2" });
    await ctx.manager.recover(id2, RecoveryTrigger.APP_RESTART);
    assert.equal(ctx.calls.resume.length, 1);
  });

  it("reportInterruption → autoRecover runs one recovery", async () => {
    const id = await seedSync(ctx.manager);
    await ctx.manager.reportInterruption(id, RecoveryTrigger.INTERRUPTED_SYNC, { autoRecover: true });
    assert.equal((await ctx.manager.getRecord(id)).state, ReliabilityState.TRACKING);
    assert.equal(ctx.calls.resume.length, 1);
  });

  it("fails gracefully after exhausting attempts — checkpoint intact", async () => {
    const ctx2 = makeManager({ resumeResult: false, retryPolicy: { maxAttempts: 3 } });
    const id = await seedSync(ctx2.manager);
    for (let i = 0; i < 4; i++) {
      try {
        await ctx2.manager.recover(id, RecoveryTrigger.STALL_TIMEOUT);
      } catch {
        break;
      }
    }
    const rec = await ctx2.manager.getRecord(id);
    assert.equal(rec.state, ReliabilityState.FAILED);
    assert.equal(rec.checkpoint.completedOperations, 40, "checkpoint intact — resumable later, not corrupted");
    assert.equal(countEvents(ctx2.captured, ReliabilityEventType.SYNC_FAILED), 1);
  });

  it("fails gracefully when the recovery timeout is exceeded", async () => {
    const ctx3 = makeManager({ retryPolicy: { recoveryTimeoutMs: 5000, maxAttempts: 10 } });
    const id = await seedSync(ctx3.manager);
    await ctx3.manager.reportInterruption(id, RecoveryTrigger.STALL_TIMEOUT);
    ctx3.clock.advance(6000);
    const res = await ctx3.manager.recover(id, RecoveryTrigger.STALL_TIMEOUT);
    assert.equal(res.outcome, RecoveryOutcome.EXHAUSTED);
    assert.equal((await ctx3.manager.getRecord(id)).state, ReliabilityState.FAILED);
  });

  it("enforces the lifetime retry budget", async () => {
    const ctx4 = makeManager({ resumeResult: false, retryPolicy: { maxAttempts: 10, retryBudget: 2, recoveryTimeoutMs: 600_000 } });
    const id = await seedSync(ctx4.manager);
    for (let i = 0; i < 5; i++) {
      try {
        await ctx4.manager.recover(id, RecoveryTrigger.STALL_TIMEOUT);
      } catch {
        break;
      }
    }
    assert.equal((await ctx4.manager.getRecord(id)).state, ReliabilityState.FAILED);
  });

  it("cannot recover a terminal synchronization", async () => {
    const id = await seedSync(ctx.manager);
    await ctx.manager.complete(id);
    await assert.rejects(() => ctx.manager.recover(id, RecoveryTrigger.DEVICE_CRASH), /Cannot recover/);
  });
});

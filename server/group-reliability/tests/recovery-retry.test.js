/**
 * Recovery engine + retry policies (Layer 10, Sprint 3): every recovery trigger, checkpoint-preserving
 * resume, bounded attempts + retry budget + timeout, graceful failure. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, seedOperation, countEvents } from "./helpers.js";
import { ReliabilityState, RecoveryTrigger, RecoveryOutcome, RecoveryAction, ReliabilityEventType, RECOVERY_PLANS } from "../types/types.js";
import { advanceCheckpoint, planResume } from "../recovery/checkpoint.js";
import { computeBackoff, shouldRetry, withinBudget, resolveRetryPolicy } from "../retry/retryPolicy.js";
import { RecoveryCoordinator } from "../recovery/recoveryCoordinator.js";

describe("checkpoint (pure)", () => {
  it("advances monotonically + never rewinds cumulative counters", () => {
    let cp = advanceCheckpoint(null, { totalTargets: 40, completedTargets: 10, cursor: 10 });
    cp = advanceCheckpoint(cp, { completedTargets: 25, cursor: 25 });
    assert.equal(cp.completedTargets, 25);
    const late = advanceCheckpoint(cp, { completedTargets: 15, cursor: 15 }); // stale report
    assert.equal(late.completedTargets, 25, "cannot rewind");
    assert.equal(late.cursor, 25);
  });

  it("planResume computes the remaining targets", () => {
    const plan = planResume({ totalTargets: 40, cursor: 25 });
    assert.equal(plan.resumable, true);
    assert.equal(plan.fromCursor, 25);
    assert.equal(plan.remaining, 15);
    assert.equal(planResume({ totalTargets: 40, cursor: 40 }).resumable, false);
  });
});

describe("retry policy (pure)", () => {
  it("exponential backoff grows + is capped; budget + attempts bound retries", () => {
    const p = resolveRetryPolicy({ baseDelayMs: 100, factor: 2, maxDelayMs: 1000, jitter: false });
    assert.equal(computeBackoff(1, p), 100);
    assert.equal(computeBackoff(2, p), 200);
    assert.equal(computeBackoff(10, p), 1000, "capped at maxDelayMs");
    assert.ok(shouldRetry(2, { maxAttempts: 5 }));
    assert.ok(!shouldRetry(5, { maxAttempts: 5 }));
    assert.ok(withinBudget(10, { retryBudget: 25 }));
    assert.ok(!withinBudget(25, { retryBudget: 25 }));
  });

  it("NONE strategy never retries", () => {
    assert.equal(computeBackoff(1, { strategy: "none" }), Infinity);
    assert.ok(!shouldRetry(0, { strategy: "none" }));
  });
});

describe("recovery coordinator (pure)", () => {
  it("maps triggers to actions + preserves recoverability", () => {
    const c = new RecoveryCoordinator();
    assert.equal(c.resolvePlan(RecoveryTrigger.FAILED_FANOUT).action, RecoveryAction.RESUME_FROM_CHECKPOINT);
    assert.equal(c.resolvePlan(RecoveryTrigger.REKEY_FAILURE).action, RecoveryAction.RETRY);
    assert.equal(c.resolvePlan(RecoveryTrigger.MEMBERSHIP_FAILURE).action, RecoveryAction.REPLAN);
    for (const plan of Object.values(RECOVERY_PLANS)) assert.equal(plan.recoverable, true);
  });

  it("runs the mapped hook + reports the outcome", async () => {
    const c = new RecoveryCoordinator();
    const record = { checkpoint: { totalTargets: 10, cursor: 4 }, retryCount: 0, retryPolicy: resolveRetryPolicy() };
    const ok = await c.run({ record, trigger: RecoveryTrigger.FAILED_FANOUT, attempt: 1, hooks: { resumeFromCheckpoint: async () => true } });
    assert.equal(ok.outcome, RecoveryOutcome.RECOVERED);
    assert.equal(ok.resumePlan.remaining, 6);
    const bad = await c.run({ record, trigger: RecoveryTrigger.FAILED_FANOUT, attempt: 1, hooks: { resumeFromCheckpoint: async () => false } });
    assert.equal(bad.outcome, RecoveryOutcome.FAILED);
  });
});

describe("recovery through the manager", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("recovers an interrupted fan-out from its checkpoint", async () => {
    await seedOperation(ctx.manager, { totalTargets: 40 });
    await ctx.manager.checkpoint({ operationId: "op:1", completedTargets: 20, cursor: 20, failedTargets: 5, pendingTargets: 20 });
    const r = await ctx.manager.recover("op:1", RecoveryTrigger.FAILED_FANOUT);
    assert.equal(r.outcome, RecoveryOutcome.RECOVERED);
    assert.equal(r.record.state, ReliabilityState.TRACKING);
    assert.equal(r.resumePlan.fromCursor, 20);
    assert.equal(r.resumePlan.remaining, 20);
    assert.equal(countEvents(ctx.captured, ReliabilityEventType.RECOVERY_SUCCEEDED), 1);
    assert.equal(countEvents(ctx.captured, ReliabilityEventType.OPERATION_RESUMED), 1);
  });

  it("auto-recovers on reported interruption", async () => {
    await seedOperation(ctx.manager);
    const rec = await ctx.manager.reportInterruption("op:1", RecoveryTrigger.CONNECTION_LOSS, { autoRecover: true });
    assert.equal(rec.record?.state ?? rec.state, ReliabilityState.TRACKING);
  });

  it("each recovery bumps the checkpoint-preserving counters", async () => {
    await seedOperation(ctx.manager);
    await ctx.manager.recover("op:1", RecoveryTrigger.FAILED_FANOUT);
    const rec = await ctx.manager.getRecord("op:1");
    assert.equal(rec.recoveryCount, 1);
    assert.equal(rec.resumeCount, 1);
    assert.ok(rec.retryCount >= 1);
  });

  it("graceful-fails when the retry budget is exhausted, keeping the checkpoint intact", async () => {
    const ctx2 = makeManager({ retryPolicy: { maxAttempts: 2, retryBudget: 2 }, recoveryHooks: { resumeFromCheckpoint: async () => false, retry: async () => false, replan: async () => false } });
    await seedOperation(ctx2.manager, { totalTargets: 10 });
    await ctx2.manager.checkpoint({ operationId: "op:1", completedTargets: 4, cursor: 4 });
    let last;
    for (let i = 0; i < 5; i++) {
      last = await ctx2.manager.recover("op:1", RecoveryTrigger.FAILED_FANOUT).catch((e) => ({ error: e }));
      if (last?.record?.state === ReliabilityState.FAILED) break;
    }
    const rec = await ctx2.manager.getRecord("op:1");
    assert.equal(rec.state, ReliabilityState.FAILED);
    assert.equal(rec.checkpoint.cursor, 4, "checkpoint preserved through failure (resumable later)");
    assert.equal(countEvents(ctx2.captured, ReliabilityEventType.OPERATION_FAILED), 1);
  });

  it("cannot recover/resume a terminal operation", async () => {
    await seedOperation(ctx.manager);
    await ctx.manager.checkpoint({ operationId: "op:1", completedTargets: 40, cursor: 40, pendingTargets: 0 });
    await ctx.manager.complete("op:1");
    await assert.rejects(() => ctx.manager.recover("op:1", RecoveryTrigger.FAILED_FANOUT), /Cannot recover/i);
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

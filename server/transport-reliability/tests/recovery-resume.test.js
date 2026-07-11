/**
 * Transfer recovery + resume (Layer 8, Sprint 3): resume-from-checkpoint, partial recovery, checkpoint
 * monotonicity, recovery timeout, bounded attempts → graceful failure (state preserved), and the
 * recovery-plan mapping. DB-free, deterministic clock.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, seedTransfer, countEvents } from "./helpers.js";
import { planResume, advanceCheckpoint } from "../resume/resumePlanner.js";
import { RecoveryCoordinator } from "../recovery/recoveryCoordinator.js";
import { ReliabilityState, RecoveryTrigger, RecoveryAction, RecoveryOutcome, ReliabilityEventType } from "../types/types.js";

describe("resume planner (pure)", () => {
  it("resumes from the chunk after the high-water mark", () => {
    const plan = planResume({ totalChunks: 100, highWaterMark: 39, chunksAcked: 40 });
    assert.equal(plan.mode, "high-water");
    assert.equal(plan.fromIndex, 40);
    assert.equal(plan.remaining, 60);
    assert.equal(plan.resumable, true);
  });

  it("uses precise missing indices when present (partial recovery)", () => {
    const plan = planResume({ totalChunks: 100, highWaterMark: 50, missingIndices: [12, 12, 40, 7] });
    assert.equal(plan.mode, "precise");
    assert.deepEqual(plan.missingIndices, [7, 12, 40]);
    assert.equal(plan.remaining, 3);
    assert.equal(plan.fromIndex, 7);
  });

  it("reports complete when nothing remains", () => {
    const plan = planResume({ totalChunks: 10, highWaterMark: 9 });
    assert.equal(plan.resumable, false);
    assert.equal(plan.mode, "complete");
  });

  it("advanceCheckpoint is monotonic (never regresses)", () => {
    const a = advanceCheckpoint(null, { totalChunks: 100, chunksAcked: 40, highWaterMark: 39, bytesTransferred: 1000 });
    const b = advanceCheckpoint(a, { chunksAcked: 20, highWaterMark: 10, bytesTransferred: 500 }); // stale/late report
    assert.equal(b.chunksAcked, 40, "does not go backwards");
    assert.equal(b.highWaterMark, 39);
    assert.equal(b.bytesTransferred, 1000);
  });
});

describe("recovery coordinator (pure)", () => {
  it("maps triggers to actions", () => {
    const c = new RecoveryCoordinator();
    assert.equal(c.resolvePlan(RecoveryTrigger.CHUNK_TIMEOUT).action, RecoveryAction.RESUME_FROM_CHECKPOINT);
    assert.equal(c.resolvePlan(RecoveryTrigger.CONNECTION_LOSS).action, RecoveryAction.MIGRATE);
    assert.equal(c.resolvePlan(RecoveryTrigger.TEMPORARY_FAILURE).action, RecoveryAction.RETRY);
  });

  it("backoff grows and is bounded", () => {
    const c = new RecoveryCoordinator({ retryPolicy: { baseDelayMs: 100, maxDelayMs: 800, factor: 2, jitter: false } });
    assert.equal(c.backoff(1), 100);
    assert.equal(c.backoff(2), 200);
    assert.equal(c.backoff(10), 800);
    assert.equal(c.shouldRetry(4, { maxAttempts: 5 }), true);
    assert.equal(c.shouldRetry(5, { maxAttempts: 5 }), false);
  });
});

describe("manager recovery", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("recovers a stalled transfer by resuming from its checkpoint", async () => {
    const id = await seedTransfer(ctx.manager);
    const res = await ctx.manager.recover(id, RecoveryTrigger.CHUNK_TIMEOUT);
    assert.equal(res.outcome, RecoveryOutcome.RECOVERED);
    assert.equal(res.record.state, ReliabilityState.TRACKING);
    assert.equal(ctx.calls.resume.length, 1);
    assert.equal(ctx.calls.resume[0].plan.fromIndex, 40, "resume plan re-sends only chunks >= 40");
    assert.equal(res.record.resumeCount, 1);
    assert.equal(countEvents(ctx.captured, ReliabilityEventType.RECOVERY_SUCCEEDED), 1);
    assert.equal(countEvents(ctx.captured, ReliabilityEventType.RESUME_PLANNED), 1);
  });

  it("explicit resume() re-sends only the missing chunks + preserves the checkpoint", async () => {
    const id = await seedTransfer(ctx.manager);
    const { resumePlan, record } = await ctx.manager.resume(id);
    assert.equal(resumePlan.fromIndex, 40);
    assert.equal(record.checkpoint.chunksAcked, 40, "checkpoint preserved");
    assert.equal(record.resumeCount, 1);
  });

  it("reportInterruption → autoRecover runs one recovery", async () => {
    const id = await seedTransfer(ctx.manager);
    await ctx.manager.reportInterruption(id, RecoveryTrigger.STALL_TIMEOUT, { autoRecover: true });
    assert.equal((await ctx.manager.getRecord(id)).state, ReliabilityState.TRACKING);
    assert.equal(ctx.calls.resume.length, 1);
  });

  it("fails gracefully after exhausting attempts — checkpoint stays intact", async () => {
    const ctx2 = makeManager({ resumeResult: false, retryPolicy: { maxAttempts: 3 } });
    const id = await seedTransfer(ctx2.manager);
    for (let i = 0; i < 3; i++) {
      try {
        await ctx2.manager.recover(id, RecoveryTrigger.CHUNK_TIMEOUT);
      } catch {
        break;
      }
    }
    const rec = await ctx2.manager.getRecord(id);
    assert.equal(rec.state, ReliabilityState.FAILED);
    assert.equal(rec.checkpoint.chunksAcked, 40, "checkpoint intact — a resumable failure, not corruption");
    assert.equal(countEvents(ctx2.captured, ReliabilityEventType.TRANSFER_FAILED), 1);
  });

  it("fails gracefully when the recovery timeout is exceeded", async () => {
    const ctx3 = makeManager({ retryPolicy: { recoveryTimeoutMs: 5000, maxAttempts: 10 } });
    const id = await seedTransfer(ctx3.manager);
    await ctx3.manager.reportInterruption(id, RecoveryTrigger.STALL_TIMEOUT); // records recoveringSince
    ctx3.clock.advance(6000); // exceed the recovery timeout
    const res = await ctx3.manager.recover(id, RecoveryTrigger.STALL_TIMEOUT);
    assert.equal(res.outcome, RecoveryOutcome.EXHAUSTED);
    assert.equal((await ctx3.manager.getRecord(id)).state, ReliabilityState.FAILED);
  });

  it("cannot recover a terminal transfer", async () => {
    const id = await seedTransfer(ctx.manager);
    await ctx.manager.complete(id);
    await assert.rejects(() => ctx.manager.recover(id, RecoveryTrigger.CHUNK_TIMEOUT), /Cannot recover/);
  });
});

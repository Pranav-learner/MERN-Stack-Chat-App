/**
 * Recovery tests (Layer 12, Sprint 4): checkpoint, recovery engine (resume / replan / graceful-fail /
 * abandon), the interrupted-operation sweep, and graceful degradation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClock, classedError } from "./helpers.js";
import { createInMemoryReliabilityRepository } from "../repository/inMemoryReliabilityRepository.js";
import { RecoveryEngine } from "../recovery/recoveryEngine.js";
import { GracefulDegradation } from "../recovery/degradation.js";
import { createCheckpoint, isTerminal } from "../recovery/checkpoint.js";
import { FabricReliabilityEventBus } from "../events/events.js";
import { FabricOperationKind, FailureClass, OperationState, RecoveryOutcome } from "../types/types.js";

function makeEngine(config = {}) {
  const clock = makeClock();
  const repo = createInMemoryReliabilityRepository();
  const events = new FabricReliabilityEventBus();
  const engine = new RecoveryEngine({ operations: repo.operations, events, clock: clock.now, config });
  return { engine, repo, clock, events };
}

test("checkpoint lifecycle: begin → touch → complete", async () => {
  const { engine, repo } = makeEngine();
  await engine.begin("op1", FabricOperationKind.DECISION, { stage: "start" });
  let cp = await repo.operations.findById("op1");
  assert.equal(cp.state, OperationState.RUNNING);
  await engine.touch("op1", { attempt: 2, data: { stage: "mid" } });
  cp = await repo.operations.findById("op1");
  assert.equal(cp.attempt, 2);
  assert.equal(cp.data.stage, "mid");
  await engine.complete("op1");
  cp = await repo.operations.findById("op1");
  assert.equal(cp.state, OperationState.SUCCEEDED);
  assert.ok(isTerminal(cp));
});

test("recovery RESUMES a transient failure by re-running the executor", async () => {
  const { engine } = makeEngine();
  await engine.begin("op2", FabricOperationKind.DECISION);
  let ran = 0;
  const out = await engine.recover("op2", classedError(FailureClass.TRANSIENT), {
    kind: FabricOperationKind.DECISION,
    failureClass: FailureClass.TRANSIENT,
    executor: async () => {
      ran++;
      return { recovered: true };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.outcome, RecoveryOutcome.RESUMED);
  assert.equal(ran, 1);
});

test("recovery REPLANS a scheduler resource failure (no hammering)", async () => {
  const { engine } = makeEngine();
  await engine.begin("op3", FabricOperationKind.SCHEDULE);
  const out = await engine.recover("op3", classedError(FailureClass.RESOURCE), { kind: FabricOperationKind.SCHEDULE, failureClass: FailureClass.RESOURCE, executor: async () => ({}) });
  assert.equal(out.ok, true);
  assert.equal(out.outcome, RecoveryOutcome.REPLANNED);
});

test("recovery GRACEFULLY FAILS a permanent/validation error (no resume)", async () => {
  const { engine, repo } = makeEngine();
  await engine.begin("op4", FabricOperationKind.DECISION);
  let ran = 0;
  const out = await engine.recover("op4", classedError(FailureClass.VALIDATION), { kind: FabricOperationKind.DECISION, failureClass: FailureClass.VALIDATION, executor: async () => (ran++, {}) });
  assert.equal(out.ok, false);
  assert.equal(out.outcome, RecoveryOutcome.GRACEFULLY_FAILED);
  assert.equal(ran, 0, "a validation error is never resumed");
  const cp = await repo.operations.findById("op4");
  assert.equal(cp.state, OperationState.GRACEFULLY_FAILED);
});

test("recovery ABANDONS when resume keeps failing (bounded attempts)", async () => {
  const { engine } = makeEngine({ maxResumeAttempts: 2, recoveryTimeoutMs: 1000 });
  await engine.begin("op5", FabricOperationKind.DECISION);
  const out = await engine.recover("op5", classedError(FailureClass.TRANSIENT), { kind: FabricOperationKind.DECISION, failureClass: FailureClass.TRANSIENT, executor: async () => { throw classedError(FailureClass.TRANSIENT); } });
  assert.equal(out.ok, false);
  assert.equal(out.outcome, RecoveryOutcome.ABANDONED);
});

test("interrupted sweep abandons stalled operations with no executor", async () => {
  const { engine, repo, clock } = makeEngine({ stalledAfterMs: 1000 });
  await engine.begin("stalled1", FabricOperationKind.COMMUNICATION_EXECUTE);
  await engine.begin("fresh1", FabricOperationKind.COMMUNICATION_EXECUTE);
  clock.advance(2000); // both age, but we only touched them at begin
  // fresh1 is also stale by time here; make fresh1 recent by touching
  await engine.touch("fresh1", {});
  clock.advance(0);
  const result = await engine.recoverInterrupted();
  assert.ok(result.scanned >= 1);
  const cp = await repo.operations.findById("stalled1");
  assert.equal(cp.state, OperationState.GRACEFULLY_FAILED);
});

test("interrupted sweep resumes stalled ops when an executor resolver is provided", async () => {
  const { engine, clock } = makeEngine({ stalledAfterMs: 500 });
  await engine.begin("res1", FabricOperationKind.DECISION);
  clock.advance(1000);
  let resumed = 0;
  const result = await engine.recoverInterrupted({ executorResolver: () => async () => (resumed++, { ok: true }) });
  assert.equal(result.recovered, 1);
  assert.equal(resumed, 1);
});

test("graceful degradation produces per-kind fallbacks", () => {
  const deg = new GracefulDegradation();
  const routing = deg.degrade(FabricOperationKind.ROUTE_EVALUATE, new Error("x"));
  assert.equal(routing.degraded, true);
  assert.equal(routing.fallback.adaptive, false);
  const schedule = deg.degrade(FabricOperationKind.SCHEDULE, new Error("x"));
  assert.equal(schedule.fallback.mode, "immediate");
  assert.ok(deg.snapshot()[FabricOperationKind.ROUTE_EVALUATE] >= 1);
});

test("checkpoint is created RUNNING + non-terminal", () => {
  const cp = createCheckpoint({ operationId: "c", kind: FabricOperationKind.DECISION });
  assert.equal(cp.state, OperationState.RUNNING);
  assert.equal(isTerminal(cp), false);
});

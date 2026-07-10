import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy, evaluatePolicies } from "../evaluator/policyEvaluator.js";
import {
  createTimeBasedPolicy,
  createMessageCountPolicy,
  createManualPolicy,
  createSecurityEventPolicy,
  createSessionAgePolicy,
  createCustomPolicy,
} from "../policies/policyFactory.js";
import { RekeyScheduler } from "../scheduler/rekeyScheduler.js";
import { MessageCounter, buildEvaluationContext } from "../triggers/triggers.js";
import {
  validateSessionRef,
  validatePolicyDescriptor,
  assertNoPolicyConflict,
  assertNoDuplicateExecution,
  assertGenerationMatch,
  validateSchedule,
  assertSessionNotExpired,
  validateRekeyRequest,
} from "../validators/validators.js";
import {
  RekeyValidationError,
  PolicyConflictError,
  DuplicateExecutionError,
  GenerationMismatchError,
  InvalidScheduleError,
  SessionExpiredError,
} from "../errors.js";
import { ExecutionState } from "../types/types.js";

describe("policy evaluator — deterministic", () => {
  const subject = { createdAt: new Date(0).toISOString(), lastEvolutionAt: null };

  it("session-age policy (Sprint 3 addition)", () => {
    const p = createSessionAgePolicy({ maxAgeMs: 5000 });
    assert.equal(evaluatePolicy(p, subject, { sessionAgeMs: 4000 }).triggered, false);
    assert.equal(evaluatePolicy(p, subject, { sessionAgeMs: 5000 }).triggered, true);
  });

  it("delegates shared kinds to the Sprint 1 evaluator", () => {
    assert.equal(evaluatePolicy(createTimeBasedPolicy({ intervalMs: 1000 }), subject, { now: 1000 }).triggered, true);
    assert.equal(evaluatePolicy(createMessageCountPolicy({ maxMessages: 5 }), subject, { messagesSinceLastEvolution: 5 }).triggered, true);
    assert.equal(evaluatePolicy(createManualPolicy(), subject, { manual: true }).triggered, true);
    assert.equal(evaluatePolicy(createSecurityEventPolicy(), subject, { securityEvent: "x" }).triggered, true);
    assert.equal(evaluatePolicy(createCustomPolicy({ evaluate: (_s, c) => c.flag === true }), subject, { flag: true }).triggered, true);
  });

  it("is deterministic + honors disabled + evaluates a whole set in order", () => {
    const policies = [createTimeBasedPolicy({ intervalMs: 1000 }), createMessageCountPolicy({ maxMessages: 2, enabled: false })];
    const ctx = { now: 2000, messagesSinceLastEvolution: 5 };
    const a = evaluatePolicies(policies, subject, ctx);
    const b = evaluatePolicies(policies, subject, ctx);
    assert.deepEqual(a.triggered.map((t) => t.type), b.triggered.map((t) => t.type));
    assert.equal(a.anyTriggered, true);
    assert.equal(a.firstTrigger.type, "time-based");
    assert.equal(a.triggered.length, 1, "disabled message-count did not fire");
  });
});

describe("triggers — message counter + context", () => {
  it("counts, resets, deletes", () => {
    const mc = new MessageCounter();
    assert.equal(mc.increment("s"), 1);
    assert.equal(mc.increment("s", 4), 5);
    assert.equal(mc.get("s"), 5);
    mc.reset("s");
    assert.equal(mc.get("s"), 0);
    mc.delete("s");
    assert.equal(mc.size, 0);
  });

  it("buildEvaluationContext computes session age deterministically", () => {
    const ctx = buildEvaluationContext({ now: 10_000, sessionCreatedAt: new Date(4000).toISOString(), messagesSinceLastEvolution: 3 });
    assert.equal(ctx.sessionAgeMs, 6000);
    assert.equal(ctx.messagesSinceLastEvolution, 3);
    assert.equal(ctx.manual, false);
  });
});

describe("scheduler", () => {
  it("registers recurring + one-off, reports due, marks + cancels", () => {
    let now = 0;
    const s = new RekeyScheduler({ clock: () => now });
    s.register("session-000001", { intervalMs: 1000, recurring: true, dueInMs: 1000 });
    s.scheduleOnce("session-000002", { dueInMs: 2000 });
    assert.deepEqual(s.due(500), []);
    now = 1000;
    assert.deepEqual(s.due(now).sort(), ["session-000001"]);
    s.mark("session-000001", now); // recurring → next at 2000
    now = 2000;
    assert.deepEqual(s.due(now).sort(), ["session-000001", "session-000002"]);
    s.mark("session-000002", now); // one-off → removed
    assert.equal(s.has("session-000002"), false);
    assert.equal(s.cancel("session-000001"), true);
    assert.equal(s.size, 0);
  });

  it("rejects invalid schedules", () => {
    const s = new RekeyScheduler({ clock: () => 0 });
    assert.throws(() => s.register("session-000001", {}), InvalidScheduleError);
    assert.throws(() => s.register("session-000001", { recurring: true, intervalMs: 0, dueInMs: 1 }), InvalidScheduleError);
  });
});

describe("validators", () => {
  it("session ref, policy descriptor + conflicts", () => {
    assert.equal(validateSessionRef("session-000001"), "session-000001");
    assert.throws(() => validateSessionRef("x"), RekeyValidationError);
    assert.throws(() => validatePolicyDescriptor({ id: "a", type: "bogus" }), RekeyValidationError);
    const manual = createManualPolicy();
    assert.throws(() => assertNoPolicyConflict([manual], manual), PolicyConflictError);
    assert.throws(() => assertNoPolicyConflict([manual], createManualPolicy()), PolicyConflictError);
    assert.doesNotThrow(() => assertNoPolicyConflict([createTimeBasedPolicy({ intervalMs: 1 })], createTimeBasedPolicy({ intervalMs: 2 })));
  });

  it("duplicate execution, generation match, schedule, expiry, request", () => {
    assert.throws(() => assertNoDuplicateExecution({ state: ExecutionState.EXECUTING }), DuplicateExecutionError);
    assert.doesNotThrow(() => assertNoDuplicateExecution({ state: ExecutionState.COMPLETED }));
    assert.throws(() => assertGenerationMatch(3, 4), GenerationMismatchError);
    assert.doesNotThrow(() => assertGenerationMatch(3, 3));
    assert.throws(() => validateSchedule({ intervalMs: -1 }), InvalidScheduleError);
    assert.throws(() => assertSessionNotExpired("expired"), SessionExpiredError);
    assert.doesNotThrow(() => assertSessionNotExpired("active"));
    assert.throws(() => validateRekeyRequest({ sessionId: "session-000001", keys: {} }), RekeyValidationError);
  });
});

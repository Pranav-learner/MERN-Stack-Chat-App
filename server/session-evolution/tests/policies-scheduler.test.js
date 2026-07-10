import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createTimeBasedPolicy,
  createMessageCountPolicy,
  createManualPolicy,
  createSecurityEventPolicy,
  createDeviceEventPolicy,
  createAdministratorPolicy,
  createCustomPolicy,
  evaluatePolicy,
  evaluatePolicies,
  isPolicyDescriptor,
  serializePolicy,
} from "../policies/policies.js";
import { EvolutionScheduler } from "../schedulers/scheduler.js";
import { EvolutionValidationError } from "../errors.js";
import { PolicyType, EvolutionTrigger } from "../types/types.js";
import { makeClock } from "./helpers.js";

const stateAt = (createdMs, lastMs = null) => ({
  createdAt: new Date(createdMs).toISOString(),
  lastEvolutionAt: lastMs ? new Date(lastMs).toISOString() : null,
  policies: [],
});

describe("evolution policies — factories + validation", () => {
  it("rejects malformed policy params", () => {
    assert.throws(() => createTimeBasedPolicy({ intervalMs: 0 }), EvolutionValidationError);
    assert.throws(() => createMessageCountPolicy({ maxMessages: -1 }), EvolutionValidationError);
    assert.throws(() => createCustomPolicy({}), EvolutionValidationError);
  });

  it("descriptors are well-formed + serializable (custom drops the fn)", () => {
    const p = createTimeBasedPolicy({ intervalMs: 1000 });
    assert.ok(isPolicyDescriptor(p));
    assert.equal(p.type, PolicyType.TIME_BASED);
    const custom = createCustomPolicy({ evaluate: () => true });
    assert.equal(typeof custom.evaluate, "function");
    assert.equal("evaluate" in serializePolicy(custom), false);
  });
});

describe("evolution policies — evaluation", () => {
  it("time-based triggers once the interval elapses", () => {
    const p = createTimeBasedPolicy({ intervalMs: 1000 });
    const state = stateAt(0);
    assert.equal(evaluatePolicy(p, state, { now: 500 }).triggered, false);
    assert.equal(evaluatePolicy(p, state, { now: 1000 }).triggered, true);
  });

  it("time-based measures from lastEvolutionAt when present", () => {
    const p = createTimeBasedPolicy({ intervalMs: 1000 });
    const state = stateAt(0, 5000);
    assert.equal(evaluatePolicy(p, state, { now: 5500 }).triggered, false);
    assert.equal(evaluatePolicy(p, state, { now: 6000 }).triggered, true);
  });

  it("message-count triggers at the threshold", () => {
    const p = createMessageCountPolicy({ maxMessages: 10 });
    assert.equal(evaluatePolicy(p, {}, { messagesSinceLastEvolution: 9 }).triggered, false);
    assert.equal(evaluatePolicy(p, {}, { messagesSinceLastEvolution: 10 }).triggered, true);
  });

  it("manual triggers only on an explicit signal", () => {
    const p = createManualPolicy();
    assert.equal(evaluatePolicy(p, {}, {}).triggered, false);
    assert.equal(evaluatePolicy(p, {}, { manual: true }).triggered, true);
  });

  it("security-event matches specific + wildcard event sets", () => {
    const specific = createSecurityEventPolicy({ events: ["compromise"] });
    assert.equal(evaluatePolicy(specific, {}, { securityEvent: "compromise" }).triggered, true);
    assert.equal(evaluatePolicy(specific, {}, { securityEvent: "login" }).triggered, false);
    const any = createSecurityEventPolicy();
    assert.equal(evaluatePolicy(any, {}, { securityEvent: "anything" }).triggered, true);
    assert.equal(evaluatePolicy(any, {}, {}).triggered, false);
  });

  it("device-event + administrator policies", () => {
    const dev = createDeviceEventPolicy({ events: ["device-added"] });
    assert.equal(evaluatePolicy(dev, {}, { deviceEvent: "device-added" }).triggered, true);
    const admin = createAdministratorPolicy();
    assert.equal(evaluatePolicy(admin, {}, { admin: true }).triggered, true);
    assert.equal(evaluatePolicy(admin, {}, {}).triggered, false);
  });

  it("custom policy runs the predicate; disabled policies never trigger", () => {
    const custom = createCustomPolicy({ evaluate: (_s, ctx) => ctx.flag === true });
    assert.equal(evaluatePolicy(custom, {}, { flag: true }).triggered, true);
    const disabled = createManualPolicy({ enabled: false });
    assert.equal(evaluatePolicy(disabled, {}, { manual: true }).triggered, false);
  });

  it("evaluatePolicies aggregates a whole set", () => {
    const state = {
      ...stateAt(0),
      policies: [createTimeBasedPolicy({ intervalMs: 1000 }), createMessageCountPolicy({ maxMessages: 5 })],
    };
    const out = evaluatePolicies(state, { now: 2000, messagesSinceLastEvolution: 2 });
    assert.equal(out.anyTriggered, true);
    assert.equal(out.triggered.length, 1);
    assert.equal(out.triggered[0].type, PolicyType.TIME_BASED);
  });
});

describe("evolution scheduler", () => {
  it("evaluate + detectTrigger use the injected clock", () => {
    const clock = makeClock(0);
    const scheduler = new EvolutionScheduler({ clock });
    const state = { ...stateAt(0), policies: [createTimeBasedPolicy({ intervalMs: 1000 })] };
    assert.equal(scheduler.detectTrigger(state), null);
    clock.advance(1000);
    assert.ok(scheduler.detectTrigger(state));
  });

  it("schedules, reports due, and cancels — never executes", () => {
    const clock = makeClock(0);
    const scheduler = new EvolutionScheduler({ clock });
    const plan = scheduler.schedule({ sessionId: "session-000001", evolutionId: "evo-1", targetGeneration: 1, dueInMs: 1000 });
    assert.equal(plan.trigger, EvolutionTrigger.SCHEDULED);
    assert.equal(scheduler.size, 1);
    assert.equal(scheduler.due(clock()).length, 0, "not yet due");
    clock.advance(1000);
    assert.equal(scheduler.due(clock()).length, 1, "now due");
    assert.ok(scheduler.cancel("session-000001"));
    assert.equal(scheduler.size, 0);
  });

  it("immediate schedule (no dueAt) is due right away; one plan per session", () => {
    const scheduler = new EvolutionScheduler({ clock: makeClock(0) });
    scheduler.schedule({ sessionId: "session-000001", evolutionId: "evo-1", targetGeneration: 1 });
    scheduler.schedule({ sessionId: "session-000001", evolutionId: "evo-1", targetGeneration: 1, reason: "override" });
    assert.equal(scheduler.size, 1);
    assert.equal(scheduler.due()[0].reason, "override");
  });
});

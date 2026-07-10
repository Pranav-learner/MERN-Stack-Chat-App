import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { RekeyEventType, ExecutionState } from "../types/types.js";
import {
  RekeyError,
  RekeyNotConfiguredError,
  PolicyConflictError,
  RekeyValidationError,
} from "../errors.js";
import {
  createManualPolicy,
  createTimeBasedPolicy,
  createMessageCountPolicy,
  createSecurityEventPolicy,
  createSessionAgePolicy,
} from "../policies/policyFactory.js";
import { makeStack, setup, startFs, captureEvents, makeSessionId } from "./helpers.js";

describe("AutomaticRekeyManager — configuration", () => {
  let stack;
  beforeEach(() => {
    stack = makeStack();
  });

  it("configures policies + emits POLICY_CONFIGURED; requires FS present", async () => {
    const { seen } = captureEvents(stack.events);
    const sid = await setup(stack, { policies: [createMessageCountPolicy({ maxMessages: 5 })] });
    const state = await stack.manager.getState(sid);
    assert.equal(state.policies.length, 1);
    assert.equal(state.config.enabled, true);
    assert.equal(state.security.automaticRekeying, true);
    assert.equal(state.security.doubleRatchet, false);
    assert.ok(seen.types().includes(RekeyEventType.POLICY_CONFIGURED));
  });

  it("rejects duplicate + singleton policy conflicts", async () => {
    const sid = await setup(stack, { policies: [createManualPolicy()] });
    await assert.rejects(() => stack.manager.attachPolicy(sid, createManualPolicy()), PolicyConflictError);
    const p = createTimeBasedPolicy({ intervalMs: 1000 });
    await stack.manager.attachPolicy(sid, p);
    await assert.rejects(() => stack.manager.attachPolicy(sid, p), PolicyConflictError);
  });

  it("attach/remove policy round-trips", async () => {
    const sid = await setup(stack, { policies: [] });
    const p = createMessageCountPolicy({ maxMessages: 3 });
    await stack.manager.attachPolicy(sid, p);
    assert.equal((await stack.manager.getPolicies(sid)).length, 1);
    await stack.manager.removePolicy(sid, p.id);
    assert.equal((await stack.manager.getPolicies(sid)).length, 0);
    await assert.rejects(() => stack.manager.removePolicy(sid, "nope"), RekeyValidationError);
  });

  it("unknown session raises RekeyNotConfiguredError", async () => {
    await assert.rejects(() => stack.manager.getState(makeSessionId(99)), RekeyNotConfiguredError);
    assert.equal(await stack.manager.findState(makeSessionId(99)), null);
  });
});

describe("AutomaticRekeyManager — manual + message-count rekey", () => {
  let stack;
  beforeEach(() => {
    stack = makeStack();
  });

  it("manual rekey advances the forward-secrecy generation", async () => {
    const { seen } = captureEvents(stack.events);
    const sid = await setup(stack, { policies: [createManualPolicy()] });
    assert.equal((await stack.fs.getStatus(sid)).currentGeneration, 0);
    const result = await stack.manager.manualRekey(sid);
    assert.equal(result.executed, true);
    assert.equal(result.execution.state, ExecutionState.COMPLETED);
    assert.equal((await stack.fs.getStatus(sid)).currentGeneration, 1);
    const types = seen.types();
    assert.ok(types.includes(RekeyEventType.REKEY_STARTED));
    assert.ok(types.includes(RekeyEventType.REKEY_COMPLETED));
    assert.ok(types.includes(RekeyEventType.GENERATION_UPDATED));
    assert.ok(types.includes(RekeyEventType.TRANSPORT_UPDATED));
  });

  it("message-count policy auto-rekeys transparently at the threshold", async () => {
    const sid = await setup(stack, { policies: [createMessageCountPolicy({ maxMessages: 3 })] });
    await stack.manager.recordMessage(sid); // 1
    await stack.manager.recordMessage(sid); // 2
    assert.equal((await stack.fs.getStatus(sid)).currentGeneration, 0, "not yet");
    const r = await stack.manager.recordMessage(sid); // 3 → fires
    assert.equal(r.rekeyed, true);
    assert.equal((await stack.fs.getStatus(sid)).currentGeneration, 1);
    // counter reset after rekey — the next threshold measures fresh traffic
    const state = await stack.manager.getState(sid);
    assert.equal(state.messageCount, 0);
    assert.equal(state.rekeyHistory.length, 1);
    assert.equal(state.rekeyHistory[0].trigger, "message-count");
  });

  it("records execution + rekey history", async () => {
    const sid = await setup(stack, { policies: [createManualPolicy()] });
    await stack.manager.manualRekey(sid);
    await stack.manager.manualRekey(sid);
    const execs = await stack.manager.getExecutionHistory(sid);
    assert.equal(execs.filter((e) => e.state === ExecutionState.COMPLETED).length, 2);
    assert.equal((await stack.manager.getRekeyHistory(sid)).length, 2);
    assert.deepEqual(
      (await stack.manager.getRekeyHistory(sid)).map((r) => r.generation),
      [1, 2],
    );
  });
});

describe("AutomaticRekeyManager — time-based, session-age, security", () => {
  it("time-based policy fires on a scheduler tick once the interval elapses", async () => {
    const stack = makeStack();
    const sid = await setup(stack, { policies: [createTimeBasedPolicy({ intervalMs: 1000 })] });
    let ticked = await stack.manager.tick(stack.clock());
    assert.equal(ticked.rekeyed, 0, "not due yet");
    stack.clock.advance(1000);
    ticked = await stack.manager.tick(stack.clock());
    assert.equal(ticked.rekeyed, 1);
    assert.equal((await stack.fs.getStatus(sid)).currentGeneration, 1);
  });

  it("session-age policy fires once the session is old enough", async () => {
    const stack = makeStack();
    const sid = await setup(stack, { policies: [createSessionAgePolicy({ maxAgeMs: 5000 })] });
    stack.clock.advance(4000);
    assert.equal((await stack.manager.tick(stack.clock())).rekeyed, 0);
    stack.clock.advance(2000); // total 6000 > 5000
    assert.equal((await stack.manager.tick(stack.clock())).rekeyed, 1);
    assert.equal((await stack.fs.getStatus(sid)).currentGeneration, 1);
  });

  it("security-event rekeys immediately and bypasses cooldown", async () => {
    const stack = makeStack({ cooldownMs: 60_000 });
    const sid = await setup(stack, { policies: [createSecurityEventPolicy(), createManualPolicy()] });
    await stack.manager.manualRekey(sid); // gen 1, sets lastRekeyAt (cooldown now active)
    const r = await stack.manager.onSecurityEvent(sid, "suspected-compromise");
    assert.equal(r.rekeyed, true, "security event bypasses cooldown");
    assert.equal((await stack.fs.getStatus(sid)).currentGeneration, 2);
  });

  it("cooldown suppresses back-to-back automatic (message-count) rekeys", async () => {
    const stack = makeStack({ cooldownMs: 10_000 });
    const sid = await setup(stack, { policies: [createMessageCountPolicy({ maxMessages: 1 })], cooldownMs: 10_000 });
    const r1 = await stack.manager.recordMessage(sid); // fires → gen 1
    assert.equal(r1.rekeyed, true);
    const r2 = await stack.manager.recordMessage(sid); // within cooldown → suppressed
    assert.equal(r2.rekeyed, false);
    assert.equal(r2.reason, "cooldown-active");
    stack.clock.advance(10_000);
    const r3 = await stack.manager.recordMessage(sid); // cooldown elapsed → fires
    assert.equal(r3.rekeyed, true);
    assert.equal((await stack.fs.getStatus(sid)).currentGeneration, 2);
  });
});

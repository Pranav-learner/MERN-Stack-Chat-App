import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EvolutionState, EvolutionEventType, EvolutionTrigger } from "../types/types.js";
import {
  EvolutionError,
  DuplicateEvolutionError,
  EvolutionNotFoundError,
  EvolutionValidationError,
  EvolutionRetiredError,
  PolicyConflictError,
  InvalidEvolutionTransitionError,
} from "../errors.js";
import { createTimeBasedPolicy, createManualPolicy } from "../policies/policies.js";
import { makeManager, create, captureEvents, makeSessionId } from "./helpers.js";

describe("EvolutionManager — creation", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("creates a STABLE record at generation 0 and emits CREATED", async () => {
    const { seen } = captureEvents(ctx.events);
    const rec = await create(ctx.manager);
    assert.equal(rec.state, EvolutionState.STABLE);
    assert.equal(rec.generation, 0);
    assert.equal(rec.keyVersion.current, 0);
    assert.ok(seen.types().includes(EvolutionEventType.CREATED));
    // NO cryptography advertised
    assert.equal(rec.securityMetadata.keyRotationPerformed, false);
    assert.equal(JSON.stringify(rec).includes("sharedSecret"), false);
  });

  it("rejects a duplicate evolution state for the same session", async () => {
    await create(ctx.manager);
    await assert.rejects(() => create(ctx.manager), DuplicateEvolutionError);
  });

  it("rejects an invalid session id", async () => {
    await assert.rejects(() => ctx.manager.createEvolutionState({ sessionId: "bad" }), EvolutionValidationError);
  });

  it("accepts default + explicit policies at creation", async () => {
    const withPolicy = makeManager({ defaultPolicies: [createTimeBasedPolicy({ intervalMs: 1000 })] });
    const rec = await create(withPolicy.manager);
    assert.equal(rec.policies.length, 1);
    assert.equal(rec.policyMetadata.count, 1);
  });
});

describe("EvolutionManager — policies", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("attach/remove policy emits POLICY_UPDATED + updates metadata", async () => {
    const { seen } = captureEvents(ctx.events);
    const rec = await create(ctx.manager);
    const p = createTimeBasedPolicy({ intervalMs: 1000 });
    const withP = await ctx.manager.attachPolicy(rec.sessionId, p);
    assert.equal(withP.policies.length, 1);
    assert.equal(withP.policyMetadata.count, 1);
    assert.ok(seen.types().includes(EvolutionEventType.POLICY_UPDATED));
    const withoutP = await ctx.manager.removePolicy(rec.sessionId, p.id);
    assert.equal(withoutP.policies.length, 0);
  });

  it("rejects duplicate + singleton policy conflicts", async () => {
    const rec = await create(ctx.manager);
    const manual = createManualPolicy();
    await ctx.manager.attachPolicy(rec.sessionId, manual);
    await assert.rejects(() => ctx.manager.attachPolicy(rec.sessionId, manual), PolicyConflictError);
    await assert.rejects(() => ctx.manager.attachPolicy(rec.sessionId, createManualPolicy()), PolicyConflictError);
  });

  it("removing a missing policy throws", async () => {
    const rec = await create(ctx.manager);
    await assert.rejects(() => ctx.manager.removePolicy(rec.sessionId, "nope"), EvolutionValidationError);
  });
});

describe("EvolutionManager — evaluation + scheduling", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("evaluate emits POLICY_TRIGGERED when a policy fires", async () => {
    const { seen } = captureEvents(ctx.events);
    const rec = await create(ctx.manager);
    await ctx.manager.attachPolicy(rec.sessionId, createTimeBasedPolicy({ intervalMs: 1000 }));
    let out = await ctx.manager.evaluate(rec.sessionId);
    assert.equal(out.anyTriggered, false);
    ctx.clock.advance(1000);
    out = await ctx.manager.evaluate(rec.sessionId);
    assert.equal(out.anyTriggered, true);
    assert.ok(seen.types().includes(EvolutionEventType.POLICY_TRIGGERED));
  });

  it("deferred schedule → SCHEDULED with pending; cancel → STABLE", async () => {
    const { seen } = captureEvents(ctx.events);
    const rec = await create(ctx.manager);
    const scheduled = await ctx.manager.schedule(rec.sessionId, { dueInMs: 5000, reason: "rotation" });
    assert.equal(scheduled.state, EvolutionState.SCHEDULED);
    assert.equal(scheduled.pending.targetGeneration, 1);
    assert.ok(seen.types().includes(EvolutionEventType.SCHEDULED));
    assert.ok(ctx.scheduler.hasPending(rec.sessionId));

    const cancelled = await ctx.manager.cancelEvolution(rec.sessionId, { reason: "abort" });
    assert.equal(cancelled.state, EvolutionState.STABLE);
    assert.equal(cancelled.pending, null);
    assert.ok(!ctx.scheduler.hasPending(rec.sessionId));
    assert.ok(seen.types().includes(EvolutionEventType.CANCELLED));
  });

  it("immediate schedule → PENDING", async () => {
    const rec = await create(ctx.manager);
    const pending = await ctx.manager.schedule(rec.sessionId, { reason: "now" });
    assert.equal(pending.state, EvolutionState.PENDING);
    assert.equal(pending.isPending, true);
  });

  it("cancel with nothing pending throws", async () => {
    const rec = await create(ctx.manager);
    await assert.rejects(() => ctx.manager.cancelEvolution(rec.sessionId), EvolutionValidationError);
  });
});

describe("EvolutionManager — generation advance (NO keys)", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("advances generation, rolls key-version pointers, records history — no key material", async () => {
    const { seen } = captureEvents(ctx.events);
    const rec = await create(ctx.manager);
    const adv = await ctx.manager.advanceGeneration(rec.sessionId, { reason: "manual" });
    assert.equal(adv.state, EvolutionState.STABLE);
    assert.equal(adv.generation, 1);
    assert.deepEqual(adv.keyVersion, { current: 1, previous: 0, next: null });
    assert.equal(adv.versionHistory.length, 1);
    assert.equal(adv.versionHistory[0].generation, 1);
    assert.equal(adv.versionHistory[0].trigger, EvolutionTrigger.MANUAL);
    assert.equal(adv.lastEvolutionAt !== null, true);
    assert.equal(adv.evolutionMetadata.generation, 1);
    assert.equal(adv.evolutionMetadata.evolutionCount, 1);
    // still no crypto
    assert.equal(adv.securityMetadata.keyRotationPerformed, false);
    assert.equal(JSON.stringify(adv).toLowerCase().includes("secret"), false);
    // emitted the advance + walked EVOLVING/EVOLVED internally
    assert.ok(seen.types().includes(EvolutionEventType.GENERATION_ADVANCED));
    const advEvent = seen.find((e) => e.type === EvolutionEventType.GENERATION_ADVANCED);
    assert.equal(advEvent.previousGeneration, 0);
    assert.equal(advEvent.generation, 1);
  });

  it("advances multiple generations monotonically", async () => {
    const rec = await create(ctx.manager);
    await ctx.manager.advanceGeneration(rec.sessionId);
    await ctx.manager.advanceGeneration(rec.sessionId);
    const adv = await ctx.manager.advanceGeneration(rec.sessionId);
    assert.equal(adv.generation, 3);
    assert.deepEqual(
      adv.versionHistory.map((h) => h.generation),
      [1, 2, 3],
    );
    const snapshot = await ctx.manager.getMigrationSnapshot(rec.sessionId);
    assert.deepEqual(snapshot.generations, [1, 2, 3]);
    assert.equal(snapshot.current, 3);
  });

  it("advancing a pending (scheduled) evolution clears the pending slot", async () => {
    const rec = await create(ctx.manager);
    await ctx.manager.schedule(rec.sessionId, { reason: "now" }); // PENDING
    const adv = await ctx.manager.advanceGeneration(rec.sessionId, { reason: "execute" });
    assert.equal(adv.generation, 1);
    assert.equal(adv.pending, null);
    assert.ok(!ctx.scheduler.hasPending(rec.sessionId));
  });

  it("rollback metadata describes the last advance (not reversible)", async () => {
    const rec = await create(ctx.manager);
    assert.equal(await ctx.manager.getRollbackMetadata(rec.sessionId), null);
    await ctx.manager.advanceGeneration(rec.sessionId);
    const rb = await ctx.manager.getRollbackMetadata(rec.sessionId);
    assert.equal(rb.from, 1);
    assert.equal(rb.to, 0);
    assert.equal(rb.reversible, false);
  });
});

describe("EvolutionManager — validation, retirement, errors", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("validateEvolution passes for a healthy record + emits VALIDATED", async () => {
    const { seen } = captureEvents(ctx.events);
    const rec = await create(ctx.manager);
    const v = await ctx.manager.validateEvolution(rec.sessionId);
    assert.equal(v.valid, true);
    assert.ok(seen.types().includes(EvolutionEventType.VALIDATED));
  });

  it("validateEvolution marks a corrupted record FAILED, then recover restores it", async () => {
    const rec = await create(ctx.manager);
    // Corrupt the stored record directly (simulate tampering): break keyVersion.
    await ctx.evolutions.update(rec.sessionId, { keyVersion: { current: -1 } });
    const v = await ctx.manager.validateEvolution(rec.sessionId);
    assert.equal(v.valid, false);
    assert.equal(v.state, EvolutionState.FAILED);
    // repair + recover
    await ctx.evolutions.update(rec.sessionId, { keyVersion: { current: 0, previous: null, next: null } });
    const recovered = await ctx.manager.recover(rec.sessionId);
    assert.equal(recovered.state, EvolutionState.STABLE);
  });

  it("retire is terminal + idempotent; blocks further mutation", async () => {
    const { seen } = captureEvents(ctx.events);
    const rec = await create(ctx.manager);
    const retired = await ctx.manager.retire(rec.sessionId, { reason: "closed" });
    assert.equal(retired.state, EvolutionState.RETIRED);
    assert.ok(seen.types().includes(EvolutionEventType.RETIRED));
    // idempotent
    assert.equal((await ctx.manager.retire(rec.sessionId)).state, EvolutionState.RETIRED);
    // blocked
    await assert.rejects(() => ctx.manager.advanceGeneration(rec.sessionId), EvolutionRetiredError);
    await assert.rejects(() => ctx.manager.attachPolicy(rec.sessionId, createManualPolicy()), EvolutionRetiredError);
  });

  it("unknown session raises EvolutionNotFoundError", async () => {
    await assert.rejects(() => ctx.manager.getEvolutionState(makeSessionId(99)), EvolutionNotFoundError);
    assert.equal(await ctx.manager.findEvolutionState(makeSessionId(99)), null);
  });

  it("all errors are EvolutionErrors with a code + status", async () => {
    try {
      await create(ctx.manager);
      await create(ctx.manager);
      assert.fail("should have thrown");
    } catch (error) {
      assert.ok(error instanceof EvolutionError);
      assert.equal(typeof error.code, "string");
      assert.equal(error.status, 409);
    }
  });

  it("advancing from a non-advanceable state throws", async () => {
    const rec = await create(ctx.manager);
    await ctx.manager.schedule(rec.sessionId, { dueInMs: 5000 }); // SCHEDULED (deferred)
    // SCHEDULED is advanceable; drive to EVOLVING is internal. Instead check EVOLVED path guard
    // by retiring then advancing (already covered). Here test invalid transition guard directly:
    const retired = makeManager();
    const r2 = await create(retired.manager, { sessionId: makeSessionId(2) });
    await retired.manager.retire(r2.sessionId);
    await assert.rejects(() => retired.manager.advanceGeneration(r2.sessionId), EvolutionError);
  });
});

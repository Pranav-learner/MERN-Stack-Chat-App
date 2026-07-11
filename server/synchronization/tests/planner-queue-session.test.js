/**
 * Planner determinism + partial plans, the session FSM, and the sync queue (Layer 9, Sprint 1). DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createSyncPlan, hashPlan, validatePlan, remainingOperations } from "../planner/syncPlanner.js";
import { canTransition, assertTransition, SessionLifecycle } from "../sessions/sessionLifecycle.js";
import { SyncQueue } from "../queue/syncQueue.js";
import { SyncSessionState, SyncCategory } from "../types/types.js";
import { InvalidPlanError } from "../errors.js";

function delta(map) {
  const categories = {};
  let total = 0;
  for (const [c, ids] of Object.entries(map)) {
    const missing = ids.map((id) => ({ entityId: id, version: 1 }));
    categories[c] = { missing, count: missing.length };
    total += missing.length;
  }
  return { categories, totalItems: total, metadata: { categories: Object.keys(map) } };
}

describe("sync planner", () => {
  it("orders by category priority + batches deterministically", () => {
    const d = delta({ [SyncCategory.MESSAGES]: ["m1", "m2", "m3"], [SyncCategory.CONVERSATIONS]: ["c1"] });
    const plan = createSyncPlan(d, { sessionId: "s1", batchSize: 2 });
    // conversations (priority 90) before messages (50).
    assert.equal(plan.ordering[0], SyncCategory.CONVERSATIONS);
    assert.equal(plan.operations[0].category, SyncCategory.CONVERSATIONS);
    // messages 3 items @ batch 2 → 2 ops (2 + 1).
    const msgOps = plan.operations.filter((o) => o.category === SyncCategory.MESSAGES);
    assert.equal(msgOps.length, 2);
    assert.deepEqual(msgOps[0].entityRefs.map((r) => r.entityId), ["m1", "m2"]);
    assert.equal(plan.totalItems, 4);
  });

  it("produces the same deterministic hash for the same delta", () => {
    const d = delta({ [SyncCategory.MESSAGES]: ["m1", "m2"] });
    const a = createSyncPlan(d, { sessionId: "s1", batchSize: 10 });
    const b = createSyncPlan(d, { sessionId: "s1", batchSize: 10 });
    assert.equal(a.deterministicHash, b.deterministicHash);
    assert.equal(a.deterministicHash, hashPlan(a));
  });

  it("produces a PARTIAL plan when the item cap is exceeded", () => {
    const d = delta({ [SyncCategory.MESSAGES]: Array.from({ length: 10 }, (_, i) => `m${i}`) });
    const plan = createSyncPlan(d, { sessionId: "s1", batchSize: 3, maxItems: 4 });
    assert.equal(plan.partial, true);
    assert.equal(plan.plannedItems, 4);
    assert.equal(plan.remainingItems, 6);
  });

  it("validatePlan rejects duplicate ids + hash tampering", () => {
    const d = delta({ [SyncCategory.MESSAGES]: ["m1"] });
    const plan = createSyncPlan(d, { sessionId: "s1" });
    assert.ok(validatePlan(plan));
    plan.deterministicHash = "tampered";
    assert.throws(() => validatePlan(plan), InvalidPlanError);
    assert.throws(() => createSyncPlan(d, { sessionId: "s1", batchSize: 0 }), InvalidPlanError);
  });

  it("remainingOperations slices from the resume cursor", () => {
    const d = delta({ [SyncCategory.MESSAGES]: ["m1", "m2", "m3"] });
    const plan = createSyncPlan(d, { sessionId: "s1", batchSize: 1 });
    assert.equal(remainingOperations(plan, 1).length, plan.operations.length - 1);
  });
});

describe("session FSM", () => {
  it("permits the sync lifecycle + pause/resume", () => {
    assert.ok(canTransition(SyncSessionState.CREATED, SyncSessionState.RUNNING));
    assert.ok(canTransition(SyncSessionState.RUNNING, SyncSessionState.PAUSED));
    assert.ok(canTransition(SyncSessionState.PAUSED, SyncSessionState.RUNNING));
    assert.ok(canTransition(SyncSessionState.RUNNING, SyncSessionState.COMPLETED));
    assert.ok(canTransition(SyncSessionState.CREATED, SyncSessionState.COMPLETED)); // empty delta
  });

  it("rejects illegal transitions", () => {
    assert.equal(canTransition(SyncSessionState.COMPLETED, SyncSessionState.RUNNING), false);
    assert.throws(() => assertTransition(SyncSessionState.COMPLETED, SyncSessionState.RUNNING), /Cannot transition/);
    assert.throws(() => assertTransition(SyncSessionState.RUNNING, "bogus"), /Unknown session state/);
  });

  it("SessionLifecycle records history", () => {
    const fsm = new SessionLifecycle();
    fsm.transition(SyncSessionState.RUNNING);
    fsm.transition(SyncSessionState.PAUSED, { reason: "manual" });
    fsm.transition(SyncSessionState.RUNNING);
    fsm.transition(SyncSessionState.COMPLETED);
    assert.equal(fsm.isTerminal, true);
    assert.equal(fsm.history.length, 4);
  });
});

describe("sync queue", () => {
  const plan = createSyncPlan(delta({ [SyncCategory.CONVERSATIONS]: ["c1"], [SyncCategory.MESSAGES]: ["m1", "m2"] }), { sessionId: "s1", batchSize: 1 });

  it("dispenses by priority, tracks applied + completion", () => {
    const q = new SyncQueue();
    q.loadFromPlan(plan, 0);
    const first = q.dequeue(1);
    assert.equal(first[0].category, SyncCategory.CONVERSATIONS, "highest priority first");
    q.markApplied(first[0].opId);
    assert.equal(q.markApplied(first[0].opId), false, "idempotent applied");
    const rest = q.dequeue();
    for (const op of rest) q.markApplied(op.opId);
    assert.equal(q.isComplete, true);
    assert.equal(q.appliedCount, plan.totalOperations);
  });

  it("pause blocks dispatch; resume restores it", () => {
    const q = new SyncQueue();
    q.loadFromPlan(plan, 0);
    q.pause();
    assert.equal(q.dequeue().length, 0);
    q.resume();
    assert.ok(q.dequeue().length > 0);
  });

  it("failed ops go to the retry queue then exhaust", () => {
    const q = new SyncQueue({ maxRetries: 2 });
    q.loadFromPlan(plan, 0);
    const [op] = q.dequeue(1);
    assert.equal(q.markFailed(op.opId), "retry");
    assert.equal(q.markFailed(op.opId), "retry");
    assert.equal(q.markFailed(op.opId), "exhausted");
    assert.equal(q.hasExhausted, true);
  });

  it("resume cursor pre-marks completed ops (counts stay correct)", () => {
    const q = new SyncQueue();
    q.loadFromPlan(plan, 2); // first 2 ops already applied
    assert.equal(q.appliedCount, 2);
    assert.equal(q.pendingCount, plan.totalOperations - 2);
  });
});

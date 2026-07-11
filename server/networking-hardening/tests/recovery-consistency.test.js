/**
 * Recovery, consistency (version/conflict/idempotency/CAS) tests (Layer 6, Sprint 6). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeClock, noSleep } from "./helpers.js";
import { RecoveryCoordinator, RECOVERY_PLANS } from "../recovery/recoveryCoordinator.js";
import {
  assertVersion,
  isNewerVersion,
  resolveConflict,
  compareAndSet,
  IdempotencyStore,
} from "../consistency/consistency.js";
import { HardeningEventBus } from "../events/events.js";
import { RecoveryKind, RecoveryAction, HardeningEventType } from "../types/types.js";
import { UnrecoverableError, ConsistencyConflictError } from "../errors.js";

// ---------------------------------------------------------------------------
describe("recovery coordinator", () => {
  it("has a plan for every recovery kind", () => {
    for (const kind of Object.values(RecoveryKind)) assert.ok(RECOVERY_PLANS[kind], `missing plan for ${kind}`);
  });

  it("retry action retries with bounded backoff and succeeds", async () => {
    let attempts = 0;
    const recovery = new RecoveryCoordinator({ sleep: noSleep, hooks: { retry: async () => { attempts++; if (attempts < 3) throw new Error("transient"); return "ok"; } } });
    const out = await recovery.recover({ kind: RecoveryKind.INTERRUPTED_DISCOVERY });
    assert.equal(out.recovered, true);
    assert.equal(out.action, RecoveryAction.RETRY);
    assert.equal(out.attempts, 3);
    assert.equal(out.result, "ok");
  });

  it("rebuild / invalidate-cache / degrade actions run the mapped hook", async () => {
    const ran = [];
    const recovery = new RecoveryCoordinator({ sleep: noSleep, hooks: { rebuild: async () => ran.push("rebuild"), invalidateCache: async () => ran.push("invalidate"), degrade: async () => ran.push("degrade") } });
    await recovery.recover({ kind: RecoveryKind.PRESENCE_INCONSISTENCY }); // rebuild
    await recovery.recover({ kind: RecoveryKind.CACHE_CORRUPTION }); // invalidate-cache
    const deg = await recovery.recover({ kind: RecoveryKind.ENDPOINT_SELECTION_FAILURE }); // degrade
    assert.deepEqual(ran, ["rebuild", "invalidate", "degrade"]);
    assert.equal(deg.degraded, true);
  });

  it("a failed recovery attempt degrades gracefully (does not throw)", async () => {
    const recovery = new RecoveryCoordinator({ sleep: noSleep, retryPolicy: { maxAttempts: 2 }, hooks: { retry: async () => { throw new Error("still down"); }, degrade: async () => "reduced" } });
    const out = await recovery.recover({ kind: RecoveryKind.REPOSITORY_FAILURE });
    assert.equal(out.recovered, false);
    assert.equal(out.degraded, true);
  });

  it("emits lifecycle events", async () => {
    const events = new HardeningEventBus();
    const seen = [];
    events.on("*", (e) => seen.push(e.type));
    const recovery = new RecoveryCoordinator({ events, sleep: noSleep, hooks: { retry: async () => "ok" } });
    await recovery.recover({ kind: RecoveryKind.INTERRUPTED_DISCOVERY });
    assert.ok(seen.includes(HardeningEventType.RECOVERY_STARTED));
    assert.ok(seen.includes(HardeningEventType.RECOVERY_COMPLETED));
  });

  it("retry() is a reusable primitive", async () => {
    let n = 0;
    const recovery = new RecoveryCoordinator({ sleep: noSleep });
    const r = await recovery.retry(async () => { n++; if (n < 2) throw new Error("x"); return 42; });
    assert.equal(r, 42);
    assert.equal(n, 2);
  });
});

// ---------------------------------------------------------------------------
describe("consistency — version + conflict", () => {
  it("assertVersion enforces an optimistic-concurrency precondition", () => {
    assert.ok(assertVersion(5, 5));
    assert.ok(assertVersion(5, undefined)); // no expectation → passes
    assert.throws(() => assertVersion(6, 5), ConsistencyConflictError);
  });

  it("isNewerVersion is monotonic", () => {
    assert.ok(isNewerVersion(3, 2));
    assert.ok(!isNewerVersion(2, 2));
    assert.ok(!isNewerVersion(1, 5));
  });

  it("resolveConflict is deterministic: higher version, then later timestamp, then id", () => {
    assert.equal(resolveConflict({ planId: "a", version: 2 }, { planId: "b", version: 5 }).winner.planId, "b");
    const t = resolveConflict({ planId: "a", version: 3, updatedAt: "2026-01-02" }, { planId: "b", version: 3, updatedAt: "2026-01-01" });
    assert.equal(t.winner.planId, "a");
    assert.equal(t.reason, "later-timestamp");
    // Full tie → id tie-break (both replicas agree).
    const idTie = resolveConflict({ planId: "z", version: 1, updatedAt: "2026-01-01" }, { planId: "a", version: 1, updatedAt: "2026-01-01" });
    assert.equal(idTie.winner.planId, "z");
    // Symmetric: swapping arguments yields the same winner.
    const swapped = resolveConflict({ planId: "a", version: 1, updatedAt: "2026-01-01" }, { planId: "z", version: 1, updatedAt: "2026-01-01" });
    assert.equal(swapped.winner.planId, "z");
  });
});

// ---------------------------------------------------------------------------
describe("consistency — idempotency store", () => {
  let clock, store;
  beforeEach(() => {
    clock = makeClock();
    store = new IdempotencyStore({ clock, ttlMs: 1000 });
  });

  it("runs an operation at most once per key within the TTL", async () => {
    let ran = 0;
    const a = await store.run("k", async () => { ran++; return { v: 1 }; });
    const b = await store.run("k", async () => { ran++; return { v: 2 }; });
    assert.equal(ran, 1);
    assert.equal(a.v, b.v);
  });

  it("coalesces concurrent duplicates into one execution", async () => {
    let ran = 0;
    const results = await Promise.all(Array.from({ length: 10 }, () => store.run("k", async () => { ran++; return ran; })));
    assert.equal(ran, 1);
    assert.ok(results.every((r) => r === 1));
  });

  it("re-runs after the TTL expires; no key → no memoization", async () => {
    let ran = 0;
    await store.run("k", async () => { ran++; });
    clock.advance(1000);
    await store.run("k", async () => { ran++; });
    assert.equal(ran, 2);
    await store.run(undefined, async () => { ran++; });
    assert.equal(ran, 3);
  });
});

// ---------------------------------------------------------------------------
describe("consistency — compareAndSet", () => {
  it("reads-modifies-writes with a version bump", async () => {
    const state = { r1: { id: "r1", version: 1, value: "a" } };
    const repo = {
      async findById(id) { return state[id] ? { ...state[id] } : null; },
      async update(id, patch) { state[id] = { ...state[id], ...patch }; return { ...state[id] }; },
    };
    const updated = await compareAndSet(repo, "r1", (cur) => ({ value: cur.value + "b" }));
    assert.equal(updated.version, 2);
    assert.equal(updated.value, "ab");
  });

  it("throws when the record vanishes", async () => {
    const repo = { async findById() { return null; }, async update() {} };
    await assert.rejects(() => compareAndSet(repo, "gone", () => ({})), ConsistencyConflictError);
  });
});

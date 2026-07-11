/**
 * Manager lifecycle + FSM + ownership, the in-memory repository, validators, security audit, and the
 * protocol freeze (Layer 9, Sprint 3). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, seedSync, countEvents } from "./helpers.js";
import { createInMemoryReliabilityRepository } from "../repository/inMemoryReliabilityRepository.js";
import { canTransition, assertTransition } from "../manager/syncReliabilityLifecycle.js";
import { assertNoPlaintext, validateRegisterRequest, validateRepository, FORBIDDEN_KEYS } from "../validators/validators.js";
import { auditSyncApis, API_SECURITY_POSTURE, SECURITY_ASSUMPTIONS, assertOwnership, normalizePagination, makeRateLimitGate, auditOperation } from "../security/securityAudit.js";
import { protocolManifest, isSyncLayerCompatible, EXTENSION_POINTS, DOES_NOT_IMPLEMENT, FROZEN_INTERFACES } from "../freeze/protocolFreeze.js";
import { ReliabilityState, ReliabilityEventType } from "../types/types.js";

describe("reliability FSM", () => {
  it("permits the recovery path + rejects illegal transitions", () => {
    assert.ok(canTransition(ReliabilityState.TRACKING, ReliabilityState.INTERRUPTED));
    assert.ok(canTransition(ReliabilityState.INTERRUPTED, ReliabilityState.RECOVERING));
    assert.ok(canTransition(ReliabilityState.RECOVERING, ReliabilityState.TRACKING));
    assert.ok(canTransition(ReliabilityState.TRACKING, ReliabilityState.COMPLETED));
    assert.equal(canTransition(ReliabilityState.COMPLETED, ReliabilityState.TRACKING), false);
    assert.throws(() => assertTransition(ReliabilityState.COMPLETED, ReliabilityState.TRACKING), /Cannot transition/);
    assert.throws(() => assertTransition(ReliabilityState.TRACKING, "bogus"), /Unknown reliability state/);
  });
});

describe("manager lifecycle", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("registers idempotently + checkpoints monotonically", async () => {
    await ctx.manager.registerSync({ sessionId: "s1", replicaId: "r1", deviceId: "phone", userId: "u1", totalOperations: 10 });
    const again = await ctx.manager.registerSync({ sessionId: "s1", replicaId: "r1", deviceId: "phone", userId: "u1", totalOperations: 10 });
    assert.equal(again.syncId, "s1");
    await ctx.manager.checkpoint({ syncId: "s1", completedOperations: 5, cursor: 5 });
    const r = await ctx.manager.checkpoint({ syncId: "s1", completedOperations: 3, cursor: 2 });
    assert.equal(r.checkpoint.completedOperations, 5, "monotonic");
  });

  it("completes + abandons", async () => {
    const id = await seedSync(ctx.manager);
    assert.equal((await ctx.manager.complete(id)).state, ReliabilityState.COMPLETED);
    const id2 = await seedSync(ctx.manager, { sessionId: "s2" });
    assert.equal((await ctx.manager.abandon(id2)).state, ReliabilityState.ABANDONED);
  });

  it("toggles TRACKING ↔ DEGRADED from health", async () => {
    const id = await seedSync(ctx.manager, { checkpoint: { completedOperations: 2, cursor: 2, replicaDrift: 98, pendingOperations: 98 } });
    ctx.clock.advance(70_000);
    const r = await ctx.manager.checkpoint({ syncId: id, completedOperations: 3, cursor: 3, replicaDrift: 97 });
    assert.equal(r.state, ReliabilityState.DEGRADED);
    assert.ok(countEvents(ctx.captured, ReliabilityEventType.HEALTH_CHANGED) >= 1);
  });

  it("owner-scopes access + builds diagnostics/health", async () => {
    const id = await seedSync(ctx.manager);
    await assert.rejects(() => ctx.manager.getRecord(id, { actingDevice: "mallory" }), /does not own/);
    await ctx.manager.recover(id, "device-crash");
    const diag = await ctx.manager.getDiagnostics(id);
    assert.equal(diag.syncId, id);
    assert.ok(diag.resumePlan);
    assert.ok(diag.counters.resumeCount >= 1);
    const health = await ctx.manager.health();
    assert.equal(health.framework, "synchronization-reliability");
  });

  it("rejects a plaintext-bearing metadata field", async () => {
    await assert.rejects(
      () => ctx.manager.registerSync({ sessionId: "sx", deviceId: "phone", userId: "u1", metadata: { content: "leak" } }),
      /plaintext|secret|content/i,
    );
  });

  it("lists a user's syncs", async () => {
    await seedSync(ctx.manager, { sessionId: "s1", deviceId: "phone", userId: "u1" });
    await seedSync(ctx.manager, { sessionId: "s2", deviceId: "laptop", userId: "u2" });
    assert.equal((await ctx.manager.listSyncs({ userId: "u1" })).length, 1);
  });
});

describe("in-memory repository", () => {
  let repo;
  beforeEach(() => {
    repo = createInMemoryReliabilityRepository();
  });

  const rec = (over = {}) => ({ syncId: "s1", deviceId: "phone", userId: "u1", state: "tracking", registeredAt: new Date(1000).toISOString(), lastActivityAt: new Date(1000).toISOString(), ...over });

  it("create/find/update/delete + listActive/stalled/countByState", async () => {
    await repo.records.create(rec());
    await repo.records.update("s1", { state: "degraded" });
    assert.equal((await repo.records.findById("s1")).state, "degraded");
    assert.equal((await repo.records.listActive("phone")).length, 1);
    assert.deepEqual((await repo.records.listStalled(1000 + 60_000, 45_000)).map((r) => r.syncId), ["s1"]);
    assert.deepEqual(await repo.records.countByState(), { degraded: 1 });
    assert.equal(await repo.records.delete("s1"), true);
  });

  it("recovery + alert history round-trip", async () => {
    await repo.recoveryHistory.record({ syncId: "s1", outcome: "recovered", at: new Date(1).toISOString() });
    assert.equal((await repo.recoveryHistory.listBySync("s1")).length, 1);
    await repo.alerts.record({ type: "stall-timeout", at: new Date(2).toISOString() });
    assert.equal((await repo.alerts.list()).total, 1);
  });
});

describe("validators + security + freeze", () => {
  it("every forbidden key rejected; register + repo validated", () => {
    for (const key of FORBIDDEN_KEYS) assert.throws(() => assertNoPlaintext({ a: { [key]: "x" } }), new RegExp(key));
    assert.throws(() => validateRegisterRequest({}), /identifier/);
    assert.throws(() => validateRepository({ records: { create() {} } }), /missing method/);
  });

  it("security audit passes + flags a missing control", () => {
    assert.equal(auditSyncApis().ok, true);
    assert.ok(SECURITY_ASSUMPTIONS.length >= 5);
    const bad = { ...API_SECURITY_POSTURE, x: { authenticated: true, ownerScoped: false, metadataOnly: true, replayProtected: true } };
    assert.equal(auditSyncApis(bad).ok, false);
    assert.throws(() => assertOwnership({ deviceId: "a", userId: "u" }, "mallory"), /does not own/);
    assert.deepEqual(normalizePagination({ limit: "9999" }), { limit: 200, offset: 0 });
    assert.equal(makeRateLimitGate()("k").allowed, true);
    assert.equal(auditOperation({ operation: "sync" }).content, undefined);
  });

  it("protocol freeze declares the whole sync layer + Layer 10 seams", () => {
    assert.equal(protocolManifest.frozen, true);
    assert.ok(FROZEN_INTERFACES.synchronization && FROZEN_INTERFACES.replication && FROZEN_INTERFACES["synchronization-reliability"]);
    assert.ok(EXTENSION_POINTS.some((e) => /vector-clock|group/i.test(e.forLayer + e.seam)));
    assert.ok(DOES_NOT_IMPLEMENT.includes("group-messaging"));
    assert.ok(DOES_NOT_IMPLEMENT.includes("crdts"));
    assert.equal(isSyncLayerCompatible("1.5"), true);
    assert.equal(isSyncLayerCompatible("2.0"), false);
  });
});

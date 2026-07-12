/**
 * Manager lifecycle + repository contracts + security/freeze (Layer 10, Sprint 3): registration,
 * ownership scoping, audit trail, validation, repo store contract, security posture, protocol freeze.
 * DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, seedOperation, countEvents } from "./helpers.js";
import { ReliabilityState, ReliabilityEventType, GroupOperationType } from "../types/types.js";
import { canTransition, assertTransition } from "../manager/groupReliabilityLifecycle.js";
import { createInMemoryGroupReliabilityRepository } from "../repository/inMemoryGroupReliabilityRepository.js";
import { assertNoPlaintext, validateRegisterRequest, validateRepository } from "../validators/validators.js";
import { auditGroupApis, assertOwnership, SECURITY_ASSUMPTIONS } from "../security/securityAudit.js";
import { protocolManifest, isGroupLayerCompatible, EXTENSION_POINTS, DOES_NOT_IMPLEMENT } from "../freeze/protocolFreeze.js";

describe("lifecycle FSM (pure)", () => {
  it("permits documented transitions + rejects illegal ones", () => {
    assert.ok(canTransition(ReliabilityState.TRACKING, ReliabilityState.INTERRUPTED));
    assert.ok(canTransition(ReliabilityState.INTERRUPTED, ReliabilityState.RECOVERING));
    assert.ok(canTransition(ReliabilityState.RECOVERING, ReliabilityState.TRACKING));
    assert.ok(!canTransition(ReliabilityState.COMPLETED, ReliabilityState.TRACKING));
    assert.ok(!canTransition(ReliabilityState.INTERRUPTED, ReliabilityState.COMPLETED));
    assert.throws(() => assertTransition(ReliabilityState.COMPLETED, ReliabilityState.TRACKING), /Cannot transition/);
  });
});

describe("manager lifecycle", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("registers idempotently + audits every mutation", async () => {
    const a = await seedOperation(ctx.manager);
    const b = await seedOperation(ctx.manager); // same operationId → idempotent
    assert.equal(a.operationId, b.operationId);
    assert.equal(countEvents(ctx.captured, ReliabilityEventType.OPERATION_REGISTERED), 1);
    await ctx.manager.checkpoint({ operationId: "op:1", completedTargets: 40, cursor: 40, pendingTargets: 0 });
    await ctx.manager.complete("op:1");
    const audit = await ctx.api.auditTrail({ groupId: "g1" });
    const ops = audit.map((e) => e.operation);
    assert.ok(ops.includes("register"));
    assert.ok(ops.includes("complete"));
  });

  it("owner-scopes reads + mutations", async () => {
    await seedOperation(ctx.manager, { deviceId: "alice" });
    await assert.rejects(() => ctx.manager.getRecord("op:1", { actingDevice: "mallory" }), /does not own/i);
    await assert.rejects(() => ctx.manager.recover("op:1", "failed-fanout", { actingDevice: "mallory" }), /does not own/i);
    await ctx.manager.getRecord("op:1", { actingDevice: "alice" }); // owner ok
  });

  it("records membership-change + key-rotation metrics by operation type", async () => {
    await seedOperation(ctx.manager, { operationId: "op:m", operationType: GroupOperationType.MEMBERSHIP_UPDATE, totalTargets: 1 });
    await seedOperation(ctx.manager, { operationId: "op:k", operationType: GroupOperationType.REKEY, totalTargets: 3, keyVersion: 2 });
    const snap = ctx.api.metrics();
    assert.equal(snap.counters.group_membership_changes_total, 1);
    assert.equal(snap.counters.group_key_rotation_total, 1);
  });

  it("abandon is terminal", async () => {
    await seedOperation(ctx.manager);
    await ctx.manager.abandon("op:1", { actingDevice: "alice", reason: "user-cancelled" });
    const rec = await ctx.manager.getRecord("op:1");
    assert.equal(rec.state, ReliabilityState.ABANDONED);
  });

  it("rejects a stale/unknown operation + malformed register", async () => {
    await assert.rejects(() => ctx.manager.getRecord("ghost"), /not found/i);
    await assert.rejects(() => ctx.manager.registerOperation({ groupId: "g", operationType: "bogus", deviceId: "d" }), /Unknown group operation type/i);
  });
});

describe("validators", () => {
  it("rejects secret/content material anywhere in a record", () => {
    assert.throws(() => assertNoPlaintext({ metadata: { groupKey: "leak" } }), /must not contain/i);
    assert.throws(() => assertNoPlaintext({ a: { ciphertext: "x" } }), /ciphertext/i);
    assert.doesNotThrow(() => assertNoPlaintext({ totalTargets: 5, health: { score: 1 } }));
  });

  it("validateRegisterRequest enforces shape", () => {
    assert.throws(() => validateRegisterRequest({ groupId: "g", deviceId: "d", operationType: "fan-out", totalTargets: -1 }), /non-negative/i);
    assert.doesNotThrow(() => validateRegisterRequest({ operationId: "o", groupId: "g", deviceId: "d", operationType: "fan-out", totalTargets: 5 }));
  });

  it("validateRepository requires the records contract", () => {
    assert.throws(() => validateRepository({}), /missing the 'records'/i);
    assert.doesNotThrow(() => validateRepository(createInMemoryGroupReliabilityRepository()));
  });
});

describe("in-memory repository contracts", () => {
  let repo;
  beforeEach(() => {
    repo = createInMemoryGroupReliabilityRepository();
  });

  it("records: create/find/update/listByGroup/listActive/listStalled/countByState", async () => {
    await repo.records.create({ operationId: "o1", groupId: "g", deviceId: "d", userId: "d", state: "tracking", registeredAt: "t", lastActivityAt: new Date(0).toISOString() });
    assert.equal((await repo.records.findById("o1")).groupId, "g");
    await repo.records.update("o1", { state: "degraded" });
    assert.equal((await repo.records.findById("o1")).state, "degraded");
    assert.equal((await repo.records.listByGroup("g")).length, 1);
    assert.equal((await repo.records.listActive("d")).length, 1);
    assert.equal((await repo.records.listStalled(Date.now(), 1000)).length, 1);
    assert.equal((await repo.records.countByState()).degraded, 1);
  });

  it("deep-copies records (no mutation by reference)", async () => {
    await repo.records.create({ operationId: "o1", groupId: "g", deviceId: "d", userId: "d", state: "tracking", checkpoint: { cursor: 1 } });
    const r = await repo.records.findById("o1");
    r.checkpoint.cursor = 999;
    assert.equal((await repo.records.findById("o1")).checkpoint.cursor, 1);
  });

  it("recoveryHistory + audit + alerts stores work", async () => {
    await repo.recoveryHistory.record({ operationId: "o1", outcome: "recovered", at: "t1" });
    assert.equal((await repo.recoveryHistory.listByOperation("o1")).length, 1);
    await repo.audit.record({ groupId: "g", operation: "register", at: "t1" });
    assert.equal((await repo.audit.listByGroup("g")).length, 1);
    await repo.alerts.record({ type: "x", at: "t1" });
    assert.equal((await repo.alerts.list()).total, 1);
  });
});

describe("security + freeze", () => {
  it("security posture is complete + documents assumptions", () => {
    const audit = auditGroupApis();
    assert.equal(audit.ok, true);
    assert.equal(audit.findings.length, 0);
    assert.ok(SECURITY_ASSUMPTIONS.some((a) => a.topic === "membership-authorization"));
    assert.ok(SECURITY_ASSUMPTIONS.some((a) => a.topic === "group-key-authorization"));
    assert.ok(SECURITY_ASSUMPTIONS.some((a) => a.topic === "audit"));
  });

  it("ownership gate", () => {
    const record = { operationId: "o", deviceId: "alice", userId: "alice" };
    assert.ok(assertOwnership(record, "alice"));
    assert.throws(() => assertOwnership(record, "mallory"), /does not own/i);
  });

  it("protocol freeze declares stable interfaces + Sprint-4 extension points + boundary", () => {
    assert.equal(protocolManifest.frozen, true);
    assert.equal(protocolManifest.framework, "layer-10-secure-group-communication");
    assert.ok(isGroupLayerCompatible("1.5"));
    assert.ok(!isGroupLayerCompatible("2.0"));
    assert.ok(EXTENSION_POINTS.some((e) => e.forLayer.includes("Sprint 4")));
    assert.ok(DOES_NOT_IMPLEMENT.includes("group-read-receipts"));
    assert.ok(DOES_NOT_IMPLEMENT.includes("blue-tick-logic"));
    assert.ok(DOES_NOT_IMPLEMENT.includes("voice-calls"));
  });
});

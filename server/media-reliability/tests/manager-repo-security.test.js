/**
 * Manager lifecycle + repository contracts + security/freeze (Layer 11, Sprint 3). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, seedOperation, countEvents } from "./helpers.js";
import { ReliabilityState, ReliabilityEventType, MediaOperationType } from "../types/types.js";
import { canTransition, assertTransition } from "../manager/mediaReliabilityLifecycle.js";
import { createInMemoryMediaReliabilityRepository } from "../repository/inMemoryMediaReliabilityRepository.js";
import { assertNoContent, validateRegisterRequest, validateRepository } from "../validators/validators.js";
import { auditMediaApis, assertOwnership, SECURITY_ASSUMPTIONS } from "../security/securityAudit.js";
import { protocolManifest, isMediaLayerCompatible, EXTENSION_POINTS, DOES_NOT_IMPLEMENT } from "../freeze/protocolFreeze.js";

describe("lifecycle FSM (pure)", () => {
  it("permits documented transitions + rejects illegal ones", () => {
    assert.ok(canTransition(ReliabilityState.TRACKING, ReliabilityState.INTERRUPTED));
    assert.ok(canTransition(ReliabilityState.INTERRUPTED, ReliabilityState.RECOVERING));
    assert.ok(canTransition(ReliabilityState.RECOVERING, ReliabilityState.TRACKING));
    assert.ok(!canTransition(ReliabilityState.COMPLETED, ReliabilityState.TRACKING));
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
    const b = await seedOperation(ctx.manager);
    assert.equal(a.operationId, b.operationId);
    assert.equal(countEvents(ctx.captured, ReliabilityEventType.OPERATION_REGISTERED), 1);
    await ctx.manager.checkpoint({ operationId: "op:1", completedChunks: 40, cursor: 40, pendingChunks: 0 });
    await ctx.manager.complete("op:1");
    const audit = await ctx.api.auditTrail({ mediaId: "m1" });
    const ops = audit.map((e) => e.operation);
    assert.ok(ops.includes("register") && ops.includes("complete"));
  });

  it("owner-scopes reads + mutations", async () => {
    await seedOperation(ctx.manager, { deviceId: "alice" });
    await assert.rejects(() => ctx.manager.getRecord("op:1", { actingDevice: "mallory" }), /does not own/i);
    await assert.rejects(() => ctx.manager.recover("op:1", "interrupted-upload", { actingDevice: "mallory" }), /does not own/i);
    await ctx.manager.getRecord("op:1", { actingDevice: "alice" });
  });

  it("records upload/download metrics on completion by type", async () => {
    await seedOperation(ctx.manager, { operationId: "u", operationType: MediaOperationType.UPLOAD, totalChunks: 2, bytesTotal: 1000 });
    await ctx.manager.checkpoint({ operationId: "u", completedChunks: 2, cursor: 2, pendingChunks: 0, bytesTransferred: 1000 });
    await ctx.manager.complete("u");
    await seedOperation(ctx.manager, { operationId: "d", operationType: MediaOperationType.DOWNLOAD, totalChunks: 2, bytesTotal: 1000 });
    await ctx.manager.checkpoint({ operationId: "d", completedChunks: 2, cursor: 2, pendingChunks: 0, bytesTransferred: 1000 });
    await ctx.manager.complete("d");
    const snap = ctx.api.metrics();
    assert.equal(snap.counters.media_upload_success_total, 1);
    assert.equal(snap.counters.media_download_success_total, 1);
  });

  it("rejects an unknown operation + malformed register", async () => {
    await assert.rejects(() => ctx.manager.getRecord("ghost"), /not found/i);
    await assert.rejects(() => ctx.manager.registerOperation({ mediaId: "m", operationType: "bogus", deviceId: "d" }), /Unknown media operation type/i);
  });
});

describe("validators", () => {
  it("rejects secret/content material anywhere in a record", () => {
    assert.throws(() => assertNoContent({ metadata: { mediaKey: "leak" } }), /must not contain/i);
    assert.throws(() => assertNoContent({ a: { ciphertext: "x" } }), /ciphertext/i);
    assert.doesNotThrow(() => assertNoContent({ totalChunks: 5, health: { score: 1 } }));
  });

  it("validateRegisterRequest enforces shape", () => {
    assert.throws(() => validateRegisterRequest({ mediaId: "m", deviceId: "d", operationType: "upload", totalChunks: -1 }), /non-negative/i);
    assert.doesNotThrow(() => validateRegisterRequest({ operationId: "o", mediaId: "m", deviceId: "d", operationType: "upload", totalChunks: 5 }));
  });

  it("validateRepository requires the records contract", () => {
    assert.throws(() => validateRepository({}), /missing the 'records'/i);
    assert.doesNotThrow(() => validateRepository(createInMemoryMediaReliabilityRepository()));
  });
});

describe("in-memory repository contracts", () => {
  let repo;
  beforeEach(() => {
    repo = createInMemoryMediaReliabilityRepository();
  });

  it("records: create/find/update/listByMedia/listActive/listStalled/countByState", async () => {
    await repo.records.create({ operationId: "o1", mediaId: "m", deviceId: "d", userId: "d", state: "tracking", registeredAt: "t", lastActivityAt: new Date(0).toISOString() });
    assert.equal((await repo.records.findById("o1")).mediaId, "m");
    await repo.records.update("o1", { state: "degraded" });
    assert.equal((await repo.records.findById("o1")).state, "degraded");
    assert.equal((await repo.records.listByMedia("m")).length, 1);
    assert.equal((await repo.records.listActive("d")).length, 1);
    assert.equal((await repo.records.listStalled(Date.now(), 1000)).length, 1);
    assert.equal((await repo.records.countByState()).degraded, 1);
  });

  it("deep-copies records", async () => {
    await repo.records.create({ operationId: "o1", mediaId: "m", deviceId: "d", userId: "d", state: "tracking", checkpoint: { cursor: 1 } });
    const r = await repo.records.findById("o1");
    r.checkpoint.cursor = 999;
    assert.equal((await repo.records.findById("o1")).checkpoint.cursor, 1);
  });
});

describe("security + freeze", () => {
  it("security posture is complete + documents assumptions", () => {
    const audit = auditMediaApis();
    assert.equal(audit.ok, true);
    assert.ok(SECURITY_ASSUMPTIONS.some((a) => a.topic === "media-authorization"));
    assert.ok(SECURITY_ASSUMPTIONS.some((a) => a.topic === "storage-authorization"));
    assert.ok(SECURITY_ASSUMPTIONS.some((a) => a.topic === "encrypted-media-integrity"));
    assert.ok(SECURITY_ASSUMPTIONS.some((a) => a.topic === "audit"));
  });

  it("ownership gate", () => {
    const record = { operationId: "o", deviceId: "alice", userId: "alice" };
    assert.ok(assertOwnership(record, "alice"));
    assert.throws(() => assertOwnership(record, "mallory"), /does not own/i);
  });

  it("protocol freeze declares Layer 11 interfaces + Layer 12 extension points + boundary", () => {
    assert.equal(protocolManifest.frozen, true);
    assert.equal(protocolManifest.framework, "layer-11-secure-media-platform");
    assert.ok(isMediaLayerCompatible("1.5"));
    assert.ok(!isMediaLayerCompatible("2.0"));
    assert.ok(EXTENSION_POINTS.some((e) => e.forLayer.includes("Layer 12")));
    assert.ok(DOES_NOT_IMPLEMENT.includes("voice-calls"));
    assert.ok(DOES_NOT_IMPLEMENT.includes("media-codecs"));
    assert.ok(DOES_NOT_IMPLEMENT.includes("webrtc-media"));
  });
});

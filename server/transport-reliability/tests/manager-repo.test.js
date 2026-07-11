/**
 * Manager lifecycle + FSM + ownership + the in-memory repository contract (Layer 8, Sprint 3). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, seedTransfer, countEvents } from "./helpers.js";
import { createInMemoryReliabilityRepository } from "../repository/inMemoryReliabilityRepository.js";
import { canTransition, assertTransition } from "../manager/transferReliabilityLifecycle.js";
import { ReliabilityState, ReliabilityEventType } from "../types/types.js";

describe("reliability FSM", () => {
  it("permits the recovery + migration paths", () => {
    assert.ok(canTransition(ReliabilityState.TRACKING, ReliabilityState.INTERRUPTED));
    assert.ok(canTransition(ReliabilityState.INTERRUPTED, ReliabilityState.RECOVERING));
    assert.ok(canTransition(ReliabilityState.RECOVERING, ReliabilityState.TRACKING));
    assert.ok(canTransition(ReliabilityState.RECOVERING, ReliabilityState.MIGRATING));
    assert.ok(canTransition(ReliabilityState.MIGRATING, ReliabilityState.TRACKING));
    assert.ok(canTransition(ReliabilityState.TRACKING, ReliabilityState.COMPLETED));
  });

  it("rejects illegal transitions", () => {
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

  it("registers idempotently + tracks a checkpoint monotonically", async () => {
    await ctx.manager.registerTransfer({ transferId: "t1", conversationId: "c1", senderDeviceId: "alice", receiverDeviceId: "bob", totalChunks: 10 });
    const again = await ctx.manager.registerTransfer({ transferId: "t1", conversationId: "c1", senderDeviceId: "alice", receiverDeviceId: "bob", totalChunks: 10 });
    assert.equal(again.transferId, "t1");
    await ctx.manager.checkpoint({ transferId: "t1", chunksAcked: 5, highWaterMark: 4, bytesTransferred: 100 });
    const r = await ctx.manager.checkpoint({ transferId: "t1", chunksAcked: 3, highWaterMark: 2, bytesTransferred: 50 }); // stale
    assert.equal(r.checkpoint.chunksAcked, 5, "monotonic — no regression");
  });

  it("completes + abandons transfers", async () => {
    const id = await seedTransfer(ctx.manager);
    const done = await ctx.manager.complete(id);
    assert.equal(done.state, ReliabilityState.COMPLETED);
    assert.equal(countEvents(ctx.captured, ReliabilityEventType.TRANSFER_COMPLETED), 1);

    const id2 = await seedTransfer(ctx.manager, { transferId: "t2" });
    const abandoned = await ctx.manager.abandon(id2);
    assert.equal(abandoned.state, ReliabilityState.ABANDONED);
  });

  it("toggles TRACKING ↔ DEGRADED from health", async () => {
    const id = await seedTransfer(ctx.manager, { checkpoint: { chunksAcked: 2, highWaterMark: 1, bytesTransferred: 100, outstanding: 1 } });
    ctx.clock.advance(40_000); // stale → unhealthy
    const r = await ctx.manager.checkpoint({ transferId: id, chunksAcked: 3, highWaterMark: 2, bytesTransferred: 150 });
    assert.equal(r.state, ReliabilityState.DEGRADED);
    assert.ok(countEvents(ctx.captured, ReliabilityEventType.HEALTH_CHANGED) >= 1);
  });

  it("enforces participant-only access", async () => {
    const id = await seedTransfer(ctx.manager);
    await assert.rejects(() => ctx.manager.getRecord(id, { actingDevice: "mallory" }), /not a participant/);
    await assert.rejects(() => ctx.manager.recover(id, "chunk-timeout", { actingDevice: "mallory" }), /not a participant/);
    const ok = await ctx.manager.getRecord(id, { actingDevice: "alice" });
    assert.equal(ok.transferId, id);
  });

  it("builds diagnostics + an aggregate health snapshot", async () => {
    const id = await seedTransfer(ctx.manager);
    await ctx.manager.recover(id, "chunk-timeout");
    const diag = await ctx.manager.getDiagnostics(id);
    assert.equal(diag.transferId, id);
    assert.ok(diag.resumePlan);
    assert.ok(diag.counters.resumeCount >= 1);
    assert.ok(diag.recoveryHistory.length >= 1);
    const health = await ctx.manager.health();
    assert.equal(health.framework, "transport-reliability");
    assert.ok(health.states);
  });

  it("lists a device's transfers", async () => {
    await seedTransfer(ctx.manager, { transferId: "t1" });
    await seedTransfer(ctx.manager, { transferId: "t2", senderDeviceId: "carol", receiverDeviceId: "dave" });
    assert.equal((await ctx.manager.listTransfers({ deviceId: "alice" })).length, 1);
    assert.equal((await ctx.manager.listTransfers({ deviceId: "carol" })).length, 1);
  });

  it("rejects a plaintext-bearing metadata field on register", async () => {
    await assert.rejects(
      () => ctx.manager.registerTransfer({ transferId: "tx", conversationId: "c1", senderDeviceId: "alice", receiverDeviceId: "bob", totalChunks: 5, metadata: { sessionKey: "leak" } }),
      /plaintext|secret|payload/i,
    );
  });
});

describe("in-memory repository", () => {
  let repo;
  beforeEach(() => {
    repo = createInMemoryReliabilityRepository();
  });

  const rec = (over = {}) => ({ transferId: "t1", conversationId: "c", senderDeviceId: "alice", receiverDeviceId: "bob", state: "tracking", registeredAt: new Date(1000).toISOString(), lastActivityAt: new Date(1000).toISOString(), ...over });

  it("create/find/update/delete + listActive/participant/stalled/countByState", async () => {
    await repo.records.create(rec());
    assert.equal((await repo.records.findById("t1")).state, "tracking");
    await repo.records.update("t1", { state: "degraded" });
    assert.equal((await repo.records.findById("t1")).state, "degraded");
    assert.equal((await repo.records.listActive("alice")).length, 1);
    assert.equal((await repo.records.listByParticipant("bob")).length, 1);
    const stalled = await repo.records.listStalled(1000 + 30_000, 20_000);
    assert.deepEqual(stalled.map((r) => r.transferId), ["t1"]);
    assert.deepEqual(await repo.records.countByState(), { degraded: 1 });
    assert.equal(await repo.records.delete("t1"), true);
  });

  it("does not list terminal transfers as active", async () => {
    await repo.records.create(rec({ transferId: "done", state: "completed" }));
    assert.equal((await repo.records.listActive()).length, 0);
  });

  it("recovery + migration + alert histories round-trip", async () => {
    await repo.recoveryHistory.record({ transferId: "t1", outcome: "recovered", at: new Date(1).toISOString() });
    assert.equal((await repo.recoveryHistory.listByTransfer("t1")).length, 1);
    await repo.migrationHistory.record({ transferId: "t1", outcome: "migrated", at: new Date(2).toISOString() });
    assert.equal((await repo.migrationHistory.listByTransfer("t1")).length, 1);
    await repo.alerts.record({ type: "stall-timeout", at: new Date(3).toISOString() });
    assert.equal((await repo.alerts.list()).total, 1);
  });

  it("stores records by deep copy (mutation isolation)", async () => {
    const r = rec();
    await repo.records.create(r);
    r.state = "TAMPERED";
    assert.equal((await repo.records.findById("t1")).state, "tracking");
  });
});

/**
 * Synchronization manager end-to-end (Layer 9, Sprint 1): initial + incremental sync, multiple
 * devices, resume/pause/cancel, ownership, expiry, empty-delta, and the replica-advance-on-completion
 * invariant. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, versions, drain, countEvents } from "./helpers.js";
import { SyncSessionState, SyncEventType } from "../types/types.js";

describe("initial synchronization", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager({ batchSize: 3 });
  });

  it("syncs a target up to a source and advances the target replica", async () => {
    await ctx.manager.registerReplica({ deviceId: "phone", userId: "u1", categoryVersions: versions({ conversations: { c1: 1, c2: 1 }, messages: { m1: 1, m2: 1, m3: 1, m4: 1 } }) });
    await ctx.manager.registerReplica({ deviceId: "laptop", userId: "u1", categoryVersions: versions({ messages: { m1: 1 } }) });

    const { session, plan } = await ctx.manager.startSync({ targetDeviceId: "laptop", sourceDeviceId: "phone" });
    assert.equal(session.state, SyncSessionState.RUNNING);
    assert.equal(plan.plannedItems, 5); // c1,c2 + m2,m3,m4
    assert.equal(countEvents(ctx.captured, SyncEventType.SYNC_STARTED), 1);
    assert.equal(countEvents(ctx.captured, SyncEventType.SYNC_PLANNED), 1);

    const status = await drain(ctx.manager, session.sessionId, { max: 2 });
    assert.equal(status.state, SyncSessionState.COMPLETED);
    assert.equal(status.progress, 1);
    assert.equal(countEvents(ctx.captured, SyncEventType.SYNC_COMPLETED), 1);

    // laptop replica is now caught up.
    const delta = await ctx.manager.computeMissingState({ targetDeviceId: "laptop", sourceDeviceId: "phone" });
    assert.equal(delta.totalItems, 0);
    const laptop = await ctx.manager.getReplica({ deviceId: "laptop" });
    assert.ok(laptop.lastSuccessfulSync);
    assert.equal(laptop.categories.messages.count, 4);
  });

  it("completes immediately when there is nothing to sync (empty delta)", async () => {
    await ctx.manager.registerReplica({ deviceId: "a", userId: "u1", categoryVersions: versions({ messages: { m1: 1 } }) });
    await ctx.manager.registerReplica({ deviceId: "b", userId: "u1", categoryVersions: versions({ messages: { m1: 1 } }) });
    const { session } = await ctx.manager.startSync({ targetDeviceId: "b", sourceDeviceId: "a" });
    assert.equal(session.state, SyncSessionState.COMPLETED);
  });
});

describe("incremental synchronization", () => {
  it("only syncs what changed since the last successful sync", async () => {
    const ctx = makeManager({ batchSize: 10 });
    await ctx.manager.registerReplica({ deviceId: "phone", userId: "u1", categoryVersions: versions({ messages: { m1: 1, m2: 1 } }) });
    await ctx.manager.registerReplica({ deviceId: "laptop", userId: "u1", categoryVersions: versions({}) });

    // First sync: 2 messages.
    let r = await ctx.manager.startSync({ targetDeviceId: "laptop", sourceDeviceId: "phone" });
    await drain(ctx.manager, r.session.sessionId);
    assert.equal((await ctx.manager.getReplica({ deviceId: "laptop" })).categories.messages.count, 2);

    // Phone gains m3; laptop syncs only the delta (1 item).
    await ctx.manager.updateReplica((await ctx.manager.getReplica({ deviceId: "phone" })).replicaId, { categoryVersions: versions({ messages: { m3: 1 } }) });
    r = await ctx.manager.startSync({ targetDeviceId: "laptop", sourceDeviceId: "phone" });
    assert.equal(r.plan.plannedItems, 1, "incremental — only m3");
    await drain(ctx.manager, r.session.sessionId);
    assert.equal((await ctx.manager.getReplica({ deviceId: "laptop" })).categories.messages.count, 3);
  });
});

describe("multiple devices", () => {
  it("syncs three devices to a common source independently", async () => {
    const ctx = makeManager({ batchSize: 5 });
    await ctx.manager.registerReplica({ deviceId: "server", userId: "u1", categoryVersions: versions({ messages: { m1: 1, m2: 1, m3: 1 } }) });
    for (const d of ["phone", "laptop", "tablet"]) {
      await ctx.manager.registerReplica({ deviceId: d, userId: "u1", categoryVersions: versions({}) });
      const { session } = await ctx.manager.startSync({ targetDeviceId: d, sourceDeviceId: "server" });
      const status = await drain(ctx.manager, session.sessionId);
      assert.equal(status.state, SyncSessionState.COMPLETED);
      assert.equal((await ctx.manager.getReplica({ deviceId: d }).then((r) => r.categories.messages.count)), 3);
    }
  });
});

describe("pause / resume / cancel", () => {
  let ctx, sessionId;
  beforeEach(async () => {
    ctx = makeManager({ batchSize: 1 });
    await ctx.manager.registerReplica({ deviceId: "phone", userId: "u1", categoryVersions: versions({ messages: { m1: 1, m2: 1, m3: 1, m4: 1 } }) });
    await ctx.manager.registerReplica({ deviceId: "laptop", userId: "u1", categoryVersions: versions({}) });
    sessionId = (await ctx.manager.startSync({ targetDeviceId: "laptop", sourceDeviceId: "phone" })).session.sessionId;
  });

  it("pauses, retains progress, and resumes to completion from the cursor", async () => {
    const first = await ctx.manager.getNextOperations({ sessionId, max: 2 });
    await ctx.manager.recordProgress({ sessionId, appliedOpIds: first.map((o) => o.opId) });
    const paused = await ctx.manager.pauseSync(sessionId);
    assert.equal(paused.state, SyncSessionState.PAUSED);
    assert.equal((await ctx.manager.getNextOperations({ sessionId })).length, 0, "no ops while paused");

    const resumed = await ctx.manager.resumeSync(sessionId);
    assert.equal(resumed.state, SyncSessionState.RUNNING);
    assert.equal(resumed.progress.completedOperations, 2, "progress retained across resume");
    const status = await drain(ctx.manager, sessionId);
    assert.equal(status.state, SyncSessionState.COMPLETED);
    assert.equal(status.completedOperations, 4);
    assert.equal(countEvents(ctx.captured, SyncEventType.SYNC_PAUSED), 1);
    assert.equal(countEvents(ctx.captured, SyncEventType.SYNC_RESUMED), 1);
  });

  it("cancels a session (terminal)", async () => {
    const cancelled = await ctx.manager.cancelSync(sessionId);
    assert.equal(cancelled.state, SyncSessionState.CANCELLED);
    assert.equal((await ctx.manager.getNextOperations({ sessionId })).length, 0);
  });

  it("expires stale sessions", async () => {
    ctx.clock.advance(2 * 60 * 60 * 1000); // past the 1h TTL
    const { expired } = await ctx.manager.sweepExpired();
    assert.equal(expired, 1);
    assert.equal((await ctx.manager.getStatus(sessionId)).state, SyncSessionState.EXPIRED);
  });
});

describe("authorization + validation", () => {
  let ctx;
  beforeEach(async () => {
    ctx = makeManager();
    await ctx.manager.registerReplica({ deviceId: "phone", userId: "u1", categoryVersions: versions({ messages: { m1: 1 } }) });
    await ctx.manager.registerReplica({ deviceId: "laptop", userId: "u1", categoryVersions: versions({}) });
  });

  it("owner-scopes session control", async () => {
    const { session } = await ctx.manager.startSync({ targetDeviceId: "laptop", sourceDeviceId: "phone", actingDevice: "laptop" });
    await assert.rejects(() => ctx.manager.pauseSync(session.sessionId, { actingDevice: "mallory" }), /does not own/);
    await assert.rejects(() => ctx.manager.getSession(session.sessionId, { actingDevice: "mallory" }), /does not own/);
  });

  it("rejects a replica whose metadata smuggles content/keys", async () => {
    await assert.rejects(
      () => ctx.manager.registerReplica({ deviceId: "x", userId: "u1", metadata: { plaintext: "leak" } }),
      /plaintext|secret|content/i,
    );
  });

  it("diagnostics + health expose control-plane state", async () => {
    const { session } = await ctx.manager.startSync({ targetDeviceId: "laptop", sourceDeviceId: "phone" });
    const diag = await ctx.manager.getDiagnostics(session.sessionId);
    assert.equal(diag.session.sessionId, session.sessionId);
    assert.ok(diag.plan);
    const health = await ctx.manager.health();
    assert.equal(health.framework, "synchronization");
  });
});

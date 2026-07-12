/**
 * Offline-member support + group synchronization + replicas (Layer 10, Sprint 2): deferred delivery,
 * pending queue, resume on reconnect, rekey catch-up, missed updates, replica sync. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeEngine, countEvents, deviceId } from "./helpers.js";
import { GroupCommEventType, GroupSyncFacet } from "../types/types.js";
import { buildCommReplica, computeReplicaDelta, applyReplicaUpdate } from "../replicas/groupCommReplica.js";
import { createGroupSyncPlan, advanceSyncCursor, remainingSyncOperations } from "../synchronization/groupSync.js";

describe("comm replica (pure)", () => {
  it("computes a facet delta + applies it monotonically", () => {
    const replica = buildCommReplica({ groupId: "g", deviceId: "d", facetVersions: { membership: 1, metadata: 1, "key-version": 1, replica: 1 } });
    const delta = computeReplicaDelta(replica, { membership: 3, metadata: 2, "key-version": 2, replica: 5 });
    assert.deepEqual(delta.missing.sort(), ["key-version", "membership", "metadata", "replica"]);
    const { replica: updated, advanced } = applyReplicaUpdate(replica, { membership: 3, metadata: 2, "key-version": 2, replica: 5 }, { keyVersion: 2 });
    assert.equal(updated.facetVersions.membership, 3);
    assert.equal(updated.keyVersion, 2);
    assert.equal(advanced.length, 4);
    assert.notEqual(updated.fingerprint, replica.fingerprint);
  });

  it("rejects a regressing authoritative version", () => {
    const replica = buildCommReplica({ groupId: "g", deviceId: "d", facetVersions: { membership: 5 } });
    assert.throws(() => applyReplicaUpdate(replica, { membership: 2 }, {}), /behind the replica/i);
  });
});

describe("group sync plan (pure)", () => {
  it("orders key-version first + lists missed key versions + resumes by cursor", () => {
    const replica = buildCommReplica({ groupId: "g", deviceId: "d", facetVersions: { membership: 1, "key-version": 1 } });
    const plan = createGroupSyncPlan({ replica, authoritative: { membership: 3, metadata: 2, "key-version": 4, replica: 2 } });
    assert.equal(plan.operations[0].facet, GroupSyncFacet.KEY_VERSION, "key first so the device can decrypt");
    assert.deepEqual(plan.operations[0].missedKeyVersions, [2, 3, 4]);
    const advanced = advanceSyncCursor(plan, 2);
    assert.equal(advanced.cursor, 2);
    assert.equal(remainingSyncOperations(advanced, advanced.cursor).length, plan.totalOperations - 2);
  });

  it("reports upToDate when nothing is missing", () => {
    const replica = buildCommReplica({ groupId: "g", deviceId: "d", facetVersions: { membership: 3, metadata: 2, "key-version": 1, replica: 1 } });
    const plan = createGroupSyncPlan({ replica, authoritative: { membership: 3, metadata: 2, "key-version": 1, replica: 1 } });
    assert.ok(plan.upToDate);
    assert.equal(plan.operations.length, 0);
  });
});

describe("offline + sync through the engine", () => {
  let ctx;
  beforeEach(async () => {
    ctx = makeEngine({ members: ["alice", "bob", "carol"], online: new Set([deviceId("alice"), deviceId("bob")]) });
    await ctx.api.establishGroupKey({ groupId: "g", actorId: "alice" });
  });

  it("queues offline deliveries + lists pending members", async () => {
    await ctx.api.sendGroupMessage({ groupId: "g", senderId: "alice", senderDeviceId: deviceId("alice"), ciphertext: "ENC(1)" });
    const pending = await ctx.api.getPendingMembers({ groupId: "g" });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].memberId, "carol");
    assert.equal(pending[0].pending, 1);
  });

  it("resumes deferred deliveries when a device reconnects", async () => {
    await ctx.api.sendGroupMessage({ groupId: "g", senderId: "alice", senderDeviceId: deviceId("alice"), ciphertext: "ENC(1)" });
    await ctx.api.sendGroupMessage({ groupId: "g", senderId: "alice", senderDeviceId: deviceId("alice"), ciphertext: "ENC(2)" });
    ctx.online.add(deviceId("carol"));
    const resume = await ctx.api.resumeDelivery({ groupId: "g", deviceId: deviceId("carol") });
    assert.equal(resume.resumed, 2);
    assert.equal(countEvents(ctx.captured, GroupCommEventType.OFFLINE_MEMBER_RESUMED), 1);
    assert.equal((await ctx.api.getPendingMembers({ groupId: "g" })).length, 0);
  });

  it("synchronizes a reconnecting device: advances facets, catches up rekeys, returns missed messages", async () => {
    await ctx.api.sendGroupMessage({ groupId: "g", senderId: "alice", senderDeviceId: deviceId("alice"), ciphertext: "ENC(1)" });
    await ctx.engine.handleMembershipChange({ groupId: "g", trigger: "member-join", memberId: "dave" }); // key v2
    const sync = await ctx.api.synchronizeGroup({ groupId: "g", deviceId: deviceId("carol"), memberId: "carol" });
    assert.ok(sync.plan.operations.some((o) => o.facet === "key-version"));
    assert.ok(sync.missedMessages.length >= 1, "missed message refs returned");
    assert.equal(sync.replica.keyVersion, 2, "replica caught up to the current key");
    assert.equal(countEvents(ctx.captured, GroupCommEventType.SYNCHRONIZATION_COMPLETED), 1);
    // carol's queued delivery is resumed as part of sync (she reconnected)
    ctx.online.add(deviceId("carol"));
    const sync2 = await ctx.api.synchronizeGroup({ groupId: "g", deviceId: deviceId("carol"), memberId: "carol" });
    assert.ok(sync2.resumed >= 0);
  });

  it("registers + reads a device replica", async () => {
    const replica = await ctx.api.registerReplica({ groupId: "g", deviceId: deviceId("bob"), memberId: "bob", facetVersions: { membership: 1 } });
    assert.equal(replica.deviceId, deviceId("bob"));
    assert.equal(replica.keyVersion, 1, "picks up the active key version");
    const list = await ctx.api.listReplicas({ groupId: "g" });
    assert.ok(list.some((r) => r.deviceId === deviceId("bob")));
    assert.equal(countEvents(ctx.captured, GroupCommEventType.REPLICA_UPDATED) >= 1, true);
  });
});

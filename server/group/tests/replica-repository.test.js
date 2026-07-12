/**
 * Group replica state + repository contracts + serializers (Layer 10, Sprint 1). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, countEvents } from "./helpers.js";
import { GroupEventType } from "../types/types.js";
import { buildReplicaState, diffReplica, replicaFingerprint, toReplicationEntities } from "../replicas/replicaState.js";
import { createInMemoryGroupRepository } from "../repository/inMemoryGroupRepository.js";

describe("replica state (pure)", () => {
  it("builds a deterministic fingerprint over material state", () => {
    const group = { groupId: "g1", metadata: { version: 1 }, versions: { group: 1, membership: 1, metadata: 1, role: 1, permission: 1, replica: 1 } };
    const members = [{ memberId: "a", role: "owner", state: "active", version: 1 }, { memberId: "b", role: "member", state: "active", version: 1 }];
    const s1 = buildReplicaState({ group, memberships: members });
    const s2 = buildReplicaState({ group, memberships: [...members].reverse() });
    assert.equal(s1.syncMetadata.fingerprint, s2.syncMetadata.fingerprint, "member order does not change the fingerprint");
    assert.equal(s1.diagnostics.countedMembers, 2);
  });

  it("diffReplica detects divergence + drift", () => {
    const group = { groupId: "g1", metadata: { version: 1 }, versions: { group: 1, membership: 1, metadata: 1, role: 1, permission: 1, replica: 1 } };
    const base = buildReplicaState({ group, memberships: [{ memberId: "a", role: "owner", state: "active", version: 1 }] });
    const grown = buildReplicaState({ group: { ...group, versions: { ...group.versions, group: 3 } }, memberships: [{ memberId: "a", role: "owner", state: "active", version: 1 }, { memberId: "b", role: "member", state: "active", version: 1 }] });
    const diff = diffReplica(base, grown);
    assert.ok(diff.diverged);
    assert.equal(diff.drift, 2);
    assert.deepEqual(diffReplica(null, base), { diverged: true, drift: 1, reason: "no-local-replica" });
  });

  it("toReplicationEntities exposes the Layer-9 sync seam", () => {
    const group = { groupId: "g1", metadata: { version: 4 }, versions: { group: 1, membership: 1, metadata: 1, role: 1, permission: 1, replica: 1 } };
    const s = buildReplicaState({ group, memberships: [{ memberId: "a", role: "owner", state: "active", version: 7 }] });
    const ent = toReplicationEntities(s);
    assert.equal(ent.membership.a, 7);
    assert.equal(ent.metadata.g1, 4);
  });
});

describe("replica state through the manager", () => {
  let ctx, g;
  beforeEach(async () => {
    ctx = makeManager();
    g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "T" } });
  });

  it("refreshes + persists a replica on every mutation + emits REPLICA_UPDATED", async () => {
    const before = await ctx.api.getReplicaState({ groupId: g.groupId });
    assert.equal(before.diagnostics.countedMembers, 1);
    await ctx.api.inviteMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" });
    await ctx.api.acceptInvitation({ groupId: g.groupId, actorId: "bob", memberId: "bob" });
    const after = await ctx.api.getReplicaState({ groupId: g.groupId });
    assert.equal(after.diagnostics.countedMembers, 2);
    assert.notEqual(before.syncMetadata.fingerprint, after.syncMetadata.fingerprint);
    assert.ok(countEvents(ctx.captured, GroupEventType.REPLICA_UPDATED) >= 1);
  });

  it("refreshReplicaState reports in-sync when nothing changed", async () => {
    const { diff } = await ctx.api.refreshReplicaState({ groupId: g.groupId });
    assert.equal(diff.diverged, false);
  });
});

describe("in-memory repository contracts", () => {
  let repo;
  beforeEach(() => {
    repo = createInMemoryGroupRepository();
  });

  it("groups: create/find/update/delete/listByOwner/exists", async () => {
    await repo.groups.create({ groupId: "g1", ownerId: "a", state: "active" });
    assert.ok(await repo.groups.exists("g1"));
    const g = await repo.groups.findById("g1");
    assert.equal(g.ownerId, "a");
    await repo.groups.update("g1", { state: "archived" });
    assert.equal((await repo.groups.findById("g1")).state, "archived");
    assert.deepEqual((await repo.groups.listByOwner("a")).map((x) => x.groupId), ["g1"]);
    assert.ok(await repo.groups.delete("g1"));
    assert.equal(await repo.groups.findById("g1"), null);
  });

  it("memberships: upsert/find/list/count with state filters", async () => {
    await repo.memberships.upsert({ membershipId: "m1", groupId: "g1", memberId: "a", role: "owner", state: "active", createdAt: "t1" });
    await repo.memberships.upsert({ membershipId: "m2", groupId: "g1", memberId: "b", role: "member", state: "invited", createdAt: "t2" });
    assert.equal((await repo.memberships.findByGroupAndMember("g1", "a")).role, "owner");
    assert.equal((await repo.memberships.listByGroup("g1")).length, 2);
    assert.equal((await repo.memberships.listByGroup("g1", { states: ["active"] })).length, 1);
    assert.equal(await repo.memberships.countByGroup("g1", { states: ["active"] }), 1);
    assert.equal((await repo.memberships.listByMember("b")).length, 1);
  });

  it("deep-copies records so callers cannot mutate stored state by reference", async () => {
    await repo.groups.create({ groupId: "g1", ownerId: "a", metadata: { name: "N" } });
    const g = await repo.groups.findById("g1");
    g.metadata.name = "MUTATED";
    assert.equal((await repo.groups.findById("g1")).metadata.name, "N");
  });

  it("returns null / throws for missing records", async () => {
    assert.equal(await repo.memberships.findById("nope"), null);
    await assert.rejects(() => repo.groups.update("ghost", {}), /not found/i);
  });
});

/**
 * Group creation + deletion + identity + lifecycle (Layer 10, Sprint 1). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, countEvents } from "./helpers.js";
import { GroupEventType, GroupRole, GroupState, MembershipState, GroupVisibility } from "../types/types.js";

describe("group creation", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("creates a group with the creator as owner + a full version vector", async () => {
    const g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "Design", description: "UX squad", tags: ["ux", "ux"] } });
    assert.equal(g.ownerId, "alice");
    assert.equal(g.state, GroupState.ACTIVE);
    assert.equal(g.metadata.name, "Design");
    assert.deepEqual(g.metadata.tags, ["ux"], "tags de-duplicated");
    assert.equal(g.memberCount, 1);
    assert.deepEqual(g.versions, { group: 1, membership: 1, metadata: 1, role: 1, permission: 1, replica: 1 });
    assert.equal(countEvents(ctx.captured, GroupEventType.GROUP_CREATED), 1);

    const details = await ctx.api.getGroupDetails({ groupId: g.groupId, actorId: "alice" });
    assert.equal(details.members[0].memberId, "alice");
    assert.equal(details.members[0].role, GroupRole.OWNER);
    assert.equal(details.members[0].state, MembershipState.ACTIVE);
  });

  it("adds initial members as active", async () => {
    const g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "Team" }, initialMembers: [{ memberId: "bob" }, { memberId: "carol", role: "administrator" }] });
    assert.equal(g.memberCount, 3);
    const list = await ctx.api.listMembers({ groupId: g.groupId, actorId: "alice" });
    const carol = list.members.find((m) => m.memberId === "carol");
    assert.equal(carol.role, "administrator");
  });

  it("defaults visibility to private + honours an explicit visibility", async () => {
    const priv = await ctx.api.createGroup({ ownerId: "a", metadata: { name: "P" } });
    assert.equal(priv.visibility, GroupVisibility.PRIVATE);
    const pub = await ctx.api.createGroup({ ownerId: "a", metadata: { name: "Pub", visibility: "public" } });
    assert.equal(pub.visibility, GroupVisibility.PUBLIC);
  });

  it("rejects a group with no name", async () => {
    await assert.rejects(() => ctx.api.createGroup({ ownerId: "alice", metadata: {} }), /name is required/i);
  });

  it("rejects an explicit duplicate group id", async () => {
    await ctx.api.createGroup({ ownerId: "alice", groupId: "grp1", metadata: { name: "One" } });
    await assert.rejects(() => ctx.api.createGroup({ ownerId: "bob", groupId: "grp1", metadata: { name: "Two" } }), /already exists/i);
  });

  it("rejects key/secret material in metadata", async () => {
    await assert.rejects(() => ctx.api.createGroup({ ownerId: "alice", metadata: { name: "X", custom: { sessionKey: "leak" } } }), /key\/secret material/i);
  });
});

describe("group deletion + lifecycle", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("soft-deletes a group (owner only) + tombstones memberships", async () => {
    const g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "T" }, initialMembers: [{ memberId: "bob" }] });
    await assert.rejects(() => ctx.api.deleteGroup({ groupId: g.groupId, actorId: "bob" }), /permission|owner/i);
    const deleted = await ctx.api.deleteGroup({ groupId: g.groupId, actorId: "alice" });
    assert.equal(deleted.state, GroupState.DELETED);
    assert.equal(countEvents(ctx.captured, GroupEventType.GROUP_DELETED), 1);
    const bob = await ctx.repo.memberships.findByGroupAndMember(g.groupId, "bob");
    assert.equal(bob.state, MembershipState.DELETED);
  });

  it("archives + restores a group; mutations blocked while archived", async () => {
    const g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "T" } });
    await ctx.api.archiveGroup({ groupId: g.groupId, actorId: "alice" });
    assert.equal(countEvents(ctx.captured, GroupEventType.GROUP_ARCHIVED), 1);
    await assert.rejects(() => ctx.api.inviteMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" }), /active group/i);
    const restored = await ctx.api.restoreGroup({ groupId: g.groupId, actorId: "alice" });
    assert.equal(restored.state, GroupState.ACTIVE);
    await ctx.api.inviteMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" }); // now allowed
  });

  it("bumps the group version on every mutation", async () => {
    const g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "T" } });
    assert.equal(g.versions.group, 1);
    await ctx.api.inviteMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" });
    const v = await ctx.api.getVersions({ groupId: g.groupId });
    assert.ok(v.versions.group > 1);
    assert.ok(v.versions.membership > 1);
    assert.ok(countEvents(ctx.captured, GroupEventType.GROUP_VERSION_UPDATED) >= 1);
  });
});

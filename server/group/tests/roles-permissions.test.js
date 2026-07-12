/**
 * Roles, RBAC, permissions, permission overrides, and ownership transfer (Layer 10, Sprint 1). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, countEvents } from "./helpers.js";
import { GroupEventType, GroupRole, GroupPermission } from "../types/types.js";
import { canAssignRole, canManageMember, outranks, assignableRoles, roleHierarchy } from "../roles/roles.js";
import { resolvePermissions, hasPermission, permissionMatrix, validatePermissionOverrides } from "../permissions/permissions.js";

describe("role logic (pure)", () => {
  it("ranks roles + enforces strict outranking", () => {
    assert.ok(outranks(GroupRole.OWNER, GroupRole.ADMINISTRATOR));
    assert.ok(outranks(GroupRole.ADMINISTRATOR, GroupRole.MEMBER));
    assert.ok(!outranks(GroupRole.MEMBER, GroupRole.MEMBER));
    assert.deepEqual(roleHierarchy().map((r) => r.role), [GroupRole.OWNER, GroupRole.ADMINISTRATOR, GroupRole.MODERATOR, GroupRole.MEMBER, GroupRole.GUEST]);
  });

  it("owner may assign any non-owner role; admins only strictly below themselves", () => {
    assert.ok(canAssignRole(GroupRole.OWNER, GroupRole.MEMBER, GroupRole.ADMINISTRATOR));
    assert.ok(!canAssignRole(GroupRole.OWNER, GroupRole.MEMBER, GroupRole.OWNER), "cannot assign owner");
    assert.ok(canAssignRole(GroupRole.ADMINISTRATOR, GroupRole.MEMBER, GroupRole.MODERATOR));
    assert.ok(!canAssignRole(GroupRole.ADMINISTRATOR, GroupRole.MEMBER, GroupRole.ADMINISTRATOR), "cannot assign a peer role");
    assert.ok(!canAssignRole(GroupRole.MODERATOR, GroupRole.MEMBER, GroupRole.MODERATOR), "moderator cannot assign a peer-rank role");
  });

  it("assignableRoles excludes owner + own rank", () => {
    assert.deepEqual(assignableRoles(GroupRole.ADMINISTRATOR), [GroupRole.MODERATOR, GroupRole.MEMBER, GroupRole.GUEST]);
  });

  it("canManageMember requires strictly higher rank (owner always)", () => {
    assert.ok(canManageMember(GroupRole.OWNER, GroupRole.ADMINISTRATOR));
    assert.ok(canManageMember(GroupRole.ADMINISTRATOR, GroupRole.MEMBER));
    assert.ok(!canManageMember(GroupRole.MEMBER, GroupRole.MEMBER));
  });
});

describe("permission resolution (pure)", () => {
  it("owner gets everything; member is read-only by default", () => {
    assert.ok(hasPermission(GroupRole.OWNER, GroupPermission.DELETE_GROUP));
    assert.ok(hasPermission(GroupRole.MEMBER, GroupPermission.VIEW_MEMBERS));
    assert.ok(!hasPermission(GroupRole.MEMBER, GroupPermission.INVITE_MEMBERS));
  });

  it("overrides grant + revoke deterministically", () => {
    const overrides = { member: { grant: [GroupPermission.INVITE_MEMBERS] }, administrator: { revoke: [GroupPermission.EDIT_METADATA] } };
    validatePermissionOverrides(overrides);
    assert.ok(hasPermission(GroupRole.MEMBER, GroupPermission.INVITE_MEMBERS, overrides));
    assert.ok(!hasPermission(GroupRole.ADMINISTRATOR, GroupPermission.EDIT_METADATA, overrides));
    // matrix is order-stable + owner is always full
    assert.equal(permissionMatrix(overrides).owner.length, resolvePermissions(GroupRole.OWNER).length);
  });

  it("rejects granting owner-only permissions to a non-owner", () => {
    assert.throws(() => validatePermissionOverrides({ administrator: { grant: [GroupPermission.DELETE_GROUP] } }), /owner-only/i);
    // owner can never be locked out even if a revoke is requested
    assert.ok(hasPermission(GroupRole.OWNER, GroupPermission.MANAGE_PERMISSIONS, { owner: { revoke: [GroupPermission.MANAGE_PERMISSIONS] } }));
  });
});

describe("RBAC through the manager", () => {
  let ctx, g;
  beforeEach(async () => {
    ctx = makeManager();
    g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "T" }, initialMembers: [{ memberId: "bob" }, { memberId: "carol" }] });
  });

  it("owner promotes bob to admin; bob may then invite", async () => {
    const promoted = await ctx.api.changeRole({ groupId: g.groupId, actorId: "alice", memberId: "bob", role: "administrator" });
    assert.equal(promoted.role, "administrator");
    assert.equal(countEvents(ctx.captured, GroupEventType.ROLE_CHANGED), 1);
    await ctx.api.inviteMember({ groupId: g.groupId, actorId: "bob", memberId: "dave" }); // now allowed
  });

  it("a member cannot change roles; an admin cannot promote to admin (no rank)", async () => {
    await assert.rejects(() => ctx.api.changeRole({ groupId: g.groupId, actorId: "bob", memberId: "carol", role: "moderator" }), /permission|rank/i);
    await ctx.api.changeRole({ groupId: g.groupId, actorId: "alice", memberId: "bob", role: "administrator" });
    await assert.rejects(() => ctx.api.changeRole({ groupId: g.groupId, actorId: "bob", memberId: "carol", role: "administrator" }), /rank/i);
  });

  it("cannot change the owner's role", async () => {
    await ctx.api.changeRole({ groupId: g.groupId, actorId: "alice", memberId: "bob", role: "administrator" });
    await assert.rejects(() => ctx.api.changeRole({ groupId: g.groupId, actorId: "bob", memberId: "alice", role: "member" }), /owner/i);
  });

  it("per-group override lets members invite via the manager", async () => {
    await ctx.api.updatePermissions({ groupId: g.groupId, actorId: "alice", overrides: { member: { grant: [GroupPermission.INVITE_MEMBERS] } } });
    assert.equal(countEvents(ctx.captured, GroupEventType.PERMISSION_CHANGED), 1);
    await ctx.api.inviteMember({ groupId: g.groupId, actorId: "bob", memberId: "dave" }); // member can now invite
    const perms = await ctx.api.getPermissions({ groupId: g.groupId });
    assert.ok(perms.matrix.member.includes(GroupPermission.INVITE_MEMBERS));
  });

  it("only the owner may set permission overrides", async () => {
    await ctx.api.changeRole({ groupId: g.groupId, actorId: "alice", memberId: "bob", role: "administrator" });
    await assert.rejects(() => ctx.api.updatePermissions({ groupId: g.groupId, actorId: "bob", overrides: {} }), /permission/i);
  });
});

describe("ownership transfer", () => {
  let ctx, g;
  beforeEach(async () => {
    ctx = makeManager();
    g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "T" }, initialMembers: [{ memberId: "bob" }] });
  });

  it("transfers ownership + demotes the old owner to administrator", async () => {
    const updated = await ctx.api.transferOwnership({ groupId: g.groupId, actorId: "alice", newOwnerId: "bob" });
    assert.equal(updated.ownerId, "bob");
    assert.equal(countEvents(ctx.captured, GroupEventType.OWNERSHIP_TRANSFERRED), 1);
    const details = await ctx.api.getGroupDetails({ groupId: g.groupId, actorId: "bob" });
    const alice = details.members.find((m) => m.memberId === "alice");
    const bob = details.members.find((m) => m.memberId === "bob");
    assert.equal(bob.role, GroupRole.OWNER);
    assert.equal(alice.role, GroupRole.ADMINISTRATOR);
  });

  it("rejects a circular (no-op) transfer + non-owner caller + non-member target", async () => {
    await assert.rejects(() => ctx.api.transferOwnership({ groupId: g.groupId, actorId: "alice", newOwnerId: "alice" }), /circular|already the owner/i);
    await assert.rejects(() => ctx.api.transferOwnership({ groupId: g.groupId, actorId: "bob", newOwnerId: "bob" }), /current owner/i);
    await assert.rejects(() => ctx.api.transferOwnership({ groupId: g.groupId, actorId: "alice", newOwnerId: "ghost" }), /not found|active member/i);
  });
});

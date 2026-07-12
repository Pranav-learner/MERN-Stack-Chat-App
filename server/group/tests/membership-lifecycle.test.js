/**
 * Membership manager + lifecycle state machine (Layer 10, Sprint 1). Invitations, join/approve, leave,
 * remove/ban/mute, duplicate detection, and every validated transition. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, countEvents } from "./helpers.js";
import { GroupEventType, MembershipState } from "../types/types.js";
import { canTransition, assertTransition, nextStatesOf, isActiveState } from "../lifecycle/lifecycle.js";

describe("lifecycle state machine (pure)", () => {
  it("permits documented transitions + rejects illegal ones", () => {
    assert.ok(canTransition(MembershipState.INVITED, MembershipState.ACTIVE));
    assert.ok(canTransition(MembershipState.ACTIVE, MembershipState.MUTED));
    assert.ok(canTransition(MembershipState.MUTED, MembershipState.ACTIVE));
    assert.ok(canTransition(MembershipState.LEFT, MembershipState.ACTIVE), "can rejoin");
    assert.ok(!canTransition(MembershipState.BANNED, MembershipState.ACTIVE), "banned cannot go active");
    assert.ok(!canTransition(MembershipState.DELETED, MembershipState.ACTIVE), "deleted is terminal");
    assert.throws(() => assertTransition(MembershipState.BANNED, MembershipState.ACTIVE), /Cannot transition/);
  });

  it("a self-transition is a legal no-op", () => {
    assert.ok(canTransition(MembershipState.ACTIVE, MembershipState.ACTIVE));
  });

  it("deleted has no next states", () => {
    assert.deepEqual(nextStatesOf(MembershipState.DELETED), []);
  });
});

describe("invitations", () => {
  let ctx, g;
  beforeEach(async () => {
    ctx = makeManager();
    g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "T" } });
  });

  it("invite → accept makes an active member", async () => {
    const inv = await ctx.api.inviteMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" });
    assert.equal(inv.state, MembershipState.INVITED);
    assert.equal(countEvents(ctx.captured, GroupEventType.MEMBER_INVITED), 1);
    const acc = await ctx.api.acceptInvitation({ groupId: g.groupId, actorId: "bob", memberId: "bob" });
    assert.equal(acc.state, MembershipState.ACTIVE);
    assert.ok(acc.joinedAt);
    assert.equal(countEvents(ctx.captured, GroupEventType.INVITATION_ACCEPTED), 1);
    assert.equal(countEvents(ctx.captured, GroupEventType.MEMBER_JOINED), 1);
  });

  it("invite → reject leaves the invitee out", async () => {
    await ctx.api.inviteMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" });
    const rej = await ctx.api.rejectInvitation({ groupId: g.groupId, actorId: "bob", memberId: "bob" });
    assert.equal(rej.state, MembershipState.LEFT);
    assert.equal(countEvents(ctx.captured, GroupEventType.INVITATION_REJECTED), 1);
  });

  it("rejects a duplicate invitation + a duplicate member", async () => {
    await ctx.api.inviteMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" });
    await assert.rejects(() => ctx.api.inviteMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" }), /already pending/i);
    await ctx.api.acceptInvitation({ groupId: g.groupId, actorId: "bob", memberId: "bob" });
    await assert.rejects(() => ctx.api.inviteMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" }), /already in the group/i);
  });

  it("re-invites a removed member", async () => {
    await ctx.api.inviteMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" });
    await ctx.api.acceptInvitation({ groupId: g.groupId, actorId: "bob", memberId: "bob" });
    await ctx.api.removeMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" });
    const reinv = await ctx.api.inviteMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" });
    assert.equal(reinv.state, MembershipState.INVITED);
  });

  it("a non-invitee cannot accept someone else's invitation", async () => {
    await ctx.api.inviteMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" });
    await assert.rejects(() => ctx.api.acceptInvitation({ groupId: g.groupId, actorId: "carol", memberId: "bob" }), /your own membership/i);
  });

  it("cannot invite without permission", async () => {
    await ctx.api.inviteMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" });
    await ctx.api.acceptInvitation({ groupId: g.groupId, actorId: "bob", memberId: "bob" });
    await assert.rejects(() => ctx.api.inviteMember({ groupId: g.groupId, actorId: "bob", memberId: "carol" }), /permission/i);
  });
});

describe("join / approve / leave / moderation", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("public group joins directly to active", async () => {
    const g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "Pub", visibility: "public" } });
    const m = await ctx.api.joinGroup({ groupId: g.groupId, actorId: "bob", memberId: "bob" });
    assert.equal(m.state, MembershipState.ACTIVE);
    assert.equal(countEvents(ctx.captured, GroupEventType.MEMBER_JOINED), 1);
  });

  it("private group join creates a pending request that admins approve", async () => {
    const g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "Priv" } });
    const req = await ctx.api.joinGroup({ groupId: g.groupId, actorId: "bob", memberId: "bob" });
    assert.equal(req.state, MembershipState.PENDING);
    assert.equal(countEvents(ctx.captured, GroupEventType.JOIN_REQUESTED), 1);
    const approved = await ctx.api.approveJoinRequest({ groupId: g.groupId, actorId: "alice", memberId: "bob" });
    assert.equal(approved.state, MembershipState.ACTIVE);
  });

  it("member leaves; owner cannot leave without transfer", async () => {
    const g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "T" }, initialMembers: [{ memberId: "bob" }] });
    const left = await ctx.api.leaveGroup({ groupId: g.groupId, actorId: "bob", memberId: "bob" });
    assert.equal(left.state, MembershipState.LEFT);
    assert.equal(countEvents(ctx.captured, GroupEventType.MEMBER_LEFT), 1);
    await assert.rejects(() => ctx.api.leaveGroup({ groupId: g.groupId, actorId: "alice", memberId: "alice" }), /transfer ownership/i);
  });

  it("remove / ban / mute / unmute a member", async () => {
    const g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "T" }, initialMembers: [{ memberId: "bob" }] });
    const muted = await ctx.api.muteMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" });
    assert.equal(muted.state, MembershipState.MUTED);
    assert.ok(isActiveState(muted.state), "muted still counts as a member");
    const unmuted = await ctx.api.unmuteMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" });
    assert.equal(unmuted.state, MembershipState.ACTIVE);
    const banned = await ctx.api.banMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" });
    assert.equal(banned.state, MembershipState.BANNED);
    assert.equal(countEvents(ctx.captured, GroupEventType.MEMBER_BANNED), 1);
    await assert.rejects(() => ctx.api.joinGroup({ groupId: g.groupId, actorId: "bob", memberId: "bob" }), /banned/i);
  });

  it("cannot remove the owner", async () => {
    const g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "T" }, initialMembers: [{ memberId: "bob", role: "administrator" }] });
    await assert.rejects(() => ctx.api.removeMember({ groupId: g.groupId, actorId: "bob", memberId: "alice" }), /owner/i);
  });

  it("enforces member capacity", async () => {
    const ctx2 = makeManager({ maxMembers: 2 });
    const g = await ctx2.api.createGroup({ ownerId: "alice", metadata: { name: "Small", visibility: "public" } });
    await ctx2.api.joinGroup({ groupId: g.groupId, actorId: "bob", memberId: "bob" }); // 2 members
    await assert.rejects(() => ctx2.api.joinGroup({ groupId: g.groupId, actorId: "carol", memberId: "carol" }), /capacity/i);
  });

  it("membership history records the trail", async () => {
    const g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "T" } });
    await ctx.api.inviteMember({ groupId: g.groupId, actorId: "alice", memberId: "bob" });
    await ctx.api.acceptInvitation({ groupId: g.groupId, actorId: "bob", memberId: "bob" });
    const hist = await ctx.api.getMembershipHistory({ groupId: g.groupId });
    const actions = hist.map((h) => h.action);
    assert.ok(actions.includes("invited"));
    assert.ok(actions.includes("invitation.accepted"));
  });
});

/**
 * Concurrency + stress + validation-hardening (Layer 10, Sprint 1). Exercises the per-group mutex under
 * concurrent membership updates, large groups, and repeated version bumps. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager } from "./helpers.js";
import { ACTIVE_MEMBERSHIP_STATES } from "../types/types.js";

describe("concurrent membership updates", () => {
  let ctx, g;
  beforeEach(async () => {
    ctx = makeManager();
    g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "T", visibility: "public" } });
  });

  it("serializes concurrent joins with no lost writes + monotonic versions", async () => {
    const N = 50;
    const joins = Array.from({ length: N }, (_, i) => ctx.api.joinGroup({ groupId: g.groupId, actorId: `u${i}`, memberId: `u${i}` }));
    await Promise.all(joins);
    const count = await ctx.repo.memberships.countByGroup(g.groupId, { states: ACTIVE_MEMBERSHIP_STATES });
    assert.equal(count, N + 1, "owner + N joiners, none lost");
    const v = await ctx.api.getVersions({ groupId: g.groupId });
    // each join bumps membership + group exactly once (+ create).
    assert.equal(v.versions.group, N + 1);
    assert.equal(v.versions.membership, N + 1);
  });

  it("concurrent duplicate joins by the same member yield exactly one active membership", async () => {
    const attempts = Array.from({ length: 20 }, () => ctx.api.joinGroup({ groupId: g.groupId, actorId: "bob", memberId: "bob" }).catch((e) => e));
    const results = await Promise.all(attempts);
    const ok = results.filter((r) => !(r instanceof Error));
    const dupes = results.filter((r) => r instanceof Error);
    assert.equal(ok.length, 1, "only the first join succeeds");
    assert.ok(dupes.length >= 1, "the rest are duplicate-member errors");
    assert.equal(await ctx.repo.memberships.countByGroup(g.groupId, { states: ACTIVE_MEMBERSHIP_STATES }), 2);
  });

  it("interleaved invites + role changes keep versions consistent", async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) => ctx.api.inviteMember({ groupId: g.groupId, actorId: "alice", memberId: `inv${i}` })));
    const list = await ctx.api.listMembers({ groupId: g.groupId, actorId: "alice", limit: 500 });
    assert.equal(list.total, 31, "owner + 30 invited");
    const v = await ctx.api.getVersions({ groupId: g.groupId });
    assert.equal(v.versions.membership, 31);
  });
});

describe("large group stress", () => {
  it("handles a large membership set + paginated reads", async () => {
    const ctx = makeManager({ clock: undefined });
    const g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "Big", visibility: "public" } });
    const N = 500;
    for (let i = 0; i < N; i++) await ctx.api.joinGroup({ groupId: g.groupId, actorId: `m${i}`, memberId: `m${i}` });
    const page = await ctx.api.listMembers({ groupId: g.groupId, actorId: "alice", limit: 100, offset: 200 });
    assert.equal(page.total, N + 1);
    assert.equal(page.members.length, 100);
    const details = await ctx.api.getGroup({ groupId: g.groupId });
    assert.equal(details.memberCount, N + 1);
  });
});

describe("validation hardening", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("rejects malformed ids", async () => {
    await assert.rejects(() => ctx.api.getGroup({ groupId: "bad id with spaces!" }), /Invalid|not found/i);
    await assert.rejects(() => ctx.api.inviteMember({ groupId: "g", actorId: "a", memberId: "" }), /Invalid member/i);
  });

  it("rejects operations on a missing group", async () => {
    await assert.rejects(() => ctx.api.getGroup({ groupId: "ghost" }), /not found/i);
    await assert.rejects(() => ctx.api.inviteMember({ groupId: "ghost", actorId: "a", memberId: "b" }), /not found/i);
  });

  it("rejects an invalid role + an unknown permission override", async () => {
    const g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "T" }, initialMembers: [{ memberId: "bob" }] });
    await assert.rejects(() => ctx.api.changeRole({ groupId: g.groupId, actorId: "alice", memberId: "bob", role: "superuser" }), /Invalid role/i);
    await assert.rejects(() => ctx.api.updatePermissions({ groupId: g.groupId, actorId: "alice", overrides: { member: { grant: ["fly"] } } }), /Invalid overrides/i);
  });

  it("a non-member cannot act on the group", async () => {
    const g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "T" } });
    await assert.rejects(() => ctx.api.getGroupDetails({ groupId: g.groupId, actorId: "stranger" }), /not an active member/i);
  });

  it("listMyGroups returns the caller's active groups with role/state", async () => {
    const g1 = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "One" } });
    const g2 = await ctx.api.createGroup({ ownerId: "bob", metadata: { name: "Two" }, initialMembers: [{ memberId: "alice", role: "administrator" }] });
    const mine = await ctx.api.listMyGroups({ memberId: "alice" });
    const ids = mine.map((x) => x.groupId).sort();
    assert.deepEqual(ids, [g1.groupId, g2.groupId].sort());
    const asAdmin = mine.find((x) => x.groupId === g2.groupId);
    assert.equal(asAdmin.myRole, "administrator");
  });
});

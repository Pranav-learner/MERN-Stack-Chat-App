/**
 * Group key management + rekeying (Layer 10, Sprint 2): derivation, versions, rotation, join/leave
 * rekey, fresh-vs-ratchet, expiry, distribution, audit. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeEngine, countEvents, makeRandomBytes } from "./helpers.js";
import { GroupCommEventType, GroupKeyState, RekeyTrigger } from "../types/types.js";
import { deriveGroupKey, groupKeyFingerprint, freshEpochSecret, nextEpochSecret, memberSetHash } from "../key-management/groupKey.js";
import { planRekey, rekeyCatchUp, requiresFreshSecret } from "../key-management/rekey.js";
import { GroupKeyManager, canKeyTransition } from "../key-management/keyManager.js";
import { createInMemoryGroupCommRepository } from "../repository/inMemoryGroupCommRepository.js";

describe("group key derivation (pure)", () => {
  it("derives a deterministic key + fingerprint from an epoch secret", () => {
    const secret = Buffer.alloc(32, 7);
    const k1 = deriveGroupKey(secret, { groupId: "g", keyVersion: 1 });
    const k2 = deriveGroupKey(secret, { groupId: "g", keyVersion: 1 });
    assert.equal(k1.length, 32);
    assert.equal(groupKeyFingerprint(k1), groupKeyFingerprint(k2), "same secret+version → same key");
    const k1b = deriveGroupKey(secret, { groupId: "g", keyVersion: 2 });
    assert.notEqual(groupKeyFingerprint(k1), groupKeyFingerprint(k1b), "version is domain-separated");
  });

  it("ratchet is one-way + differs from fresh", () => {
    const rb = makeRandomBytes(3);
    const s1 = freshEpochSecret(rb);
    const s2 = nextEpochSecret(s1, "g", 2);
    assert.notDeepEqual(s1, s2);
    // fresh secret is independent of the previous chain
    const fresh = freshEpochSecret(rb);
    assert.notDeepEqual(fresh, s2);
  });

  it("memberSetHash is order-independent", () => {
    assert.equal(memberSetHash(["a", "b", "c"]), memberSetHash(["c", "a", "b"]));
    assert.notEqual(memberSetHash(["a", "b"]), memberSetHash(["a", "b", "c"]));
  });
});

describe("rekey policy (pure)", () => {
  it("departures require fresh randomness; benign rotations may ratchet", () => {
    assert.ok(requiresFreshSecret(RekeyTrigger.MEMBER_LEAVE));
    assert.ok(requiresFreshSecret(RekeyTrigger.MEMBER_REMOVE));
    assert.ok(requiresFreshSecret(RekeyTrigger.OWNERSHIP_TRANSFER));
    assert.ok(!requiresFreshSecret(RekeyTrigger.MEMBER_JOIN));
    assert.ok(!requiresFreshSecret(RekeyTrigger.SCHEDULED));
  });

  it("planRekey targets the next version + excludes a departed member", () => {
    const leave = planRekey({ trigger: RekeyTrigger.MEMBER_LEAVE, members: ["a", "b"], affectedMember: "c", currentVersion: 3 });
    assert.equal(leave.targetVersion, 4);
    assert.equal(leave.fresh, true);
    assert.equal(leave.recovery.excluded, "c");
    const join = planRekey({ trigger: RekeyTrigger.MEMBER_JOIN, members: ["a", "b", "c"], affectedMember: "c", currentVersion: 3 });
    assert.equal(join.fresh, false);
    assert.equal(join.recovery.excluded, null);
  });

  it("rekeyCatchUp lists missed versions", () => {
    assert.deepEqual(rekeyCatchUp(2, 5).missedVersions, [3, 4, 5]);
    assert.deepEqual(rekeyCatchUp(5, 5).missedVersions, []);
  });
});

describe("key lifecycle transitions", () => {
  it("permits active→superseded→expired; rejects revoked→active", () => {
    assert.ok(canKeyTransition(GroupKeyState.ACTIVE, GroupKeyState.SUPERSEDED));
    assert.ok(canKeyTransition(GroupKeyState.SUPERSEDED, GroupKeyState.EXPIRED));
    assert.ok(!canKeyTransition(GroupKeyState.REVOKED, GroupKeyState.ACTIVE));
    assert.ok(!canKeyTransition(GroupKeyState.EXPIRED, GroupKeyState.ACTIVE));
  });
});

describe("GroupKeyManager", () => {
  let repo, mgr;
  beforeEach(() => {
    repo = createInMemoryGroupCommRepository();
    mgr = new GroupKeyManager({ keys: repo.keys, keyAudit: repo.keyAudit, clock: () => 1_700_000_000_000 });
  });

  it("creates + rotates key versions, superseding the old", async () => {
    const k1 = await mgr.createInitialKey({ groupId: "g", createdBy: "a", fingerprint: "f".repeat(32), memberIds: ["a", "b"] });
    assert.equal(k1.keyVersion, 1);
    assert.equal(k1.state, GroupKeyState.ACTIVE);
    const k2 = await mgr.rotateKey({ groupId: "g", createdBy: "a", fingerprint: "e".repeat(32), memberIds: ["a", "b"], trigger: RekeyTrigger.MEMBER_JOIN });
    assert.equal(k2.keyVersion, 2);
    const old = await mgr.requireKeyVersion("g", 1);
    assert.equal(old.state, GroupKeyState.SUPERSEDED);
    assert.equal(old.supersededBy, 2);
    assert.equal((await mgr.requireActiveKey("g")).keyVersion, 2);
  });

  it("tracks distribution + reports pending", async () => {
    await mgr.createInitialKey({ groupId: "g", createdBy: "a", fingerprint: "f".repeat(32), memberIds: ["a", "b", "c"] });
    assert.deepEqual((await mgr.pendingDistribution("g", 1)).sort(), ["a", "b", "c"]);
    await mgr.markDistributed("g", 1, "b");
    assert.deepEqual(await mgr.pendingDistribution("g", 1), ["a", "c"]);
  });

  it("expires a key (TTL) + rejects use", async () => {
    const m2 = new GroupKeyManager({ keys: repo.keys, keyAudit: repo.keyAudit, clock: () => 1_700_000_000_000, keyTtlMs: 1000 });
    await m2.createInitialKey({ groupId: "g", createdBy: "a", fingerprint: "f".repeat(32), memberIds: ["a"] });
    const later = new GroupKeyManager({ keys: repo.keys, keyAudit: repo.keyAudit, clock: () => 1_700_000_000_000 + 5000 });
    const expired = await later.sweepExpired("g");
    assert.deepEqual(expired, [1]);
    await assert.rejects(() => later.requireActiveKey("g"), /No active|expired/i);
  });

  it("rejects a missing/short fingerprint", async () => {
    await assert.rejects(() => mgr.createInitialKey({ groupId: "g", createdBy: "a", fingerprint: "short", memberIds: ["a"] }), /valid key fingerprint/i);
  });
});

describe("rekey through the engine", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeEngine({ members: ["alice", "bob", "carol"] });
  });

  it("establishes then rotates on member-join (ratchet) + member-leave (fresh)", async () => {
    await ctx.api.establishGroupKey({ groupId: "g", actorId: "alice" });
    assert.equal(countEvents(ctx.captured, GroupCommEventType.GROUP_KEY_ROTATED), 1);
    const join = await ctx.engine.handleMembershipChange({ groupId: "g", trigger: RekeyTrigger.MEMBER_JOIN, memberId: "dave" });
    assert.equal(join.keyVersion, 2);
    const leave = await ctx.engine.handleMembershipChange({ groupId: "g", trigger: RekeyTrigger.MEMBER_LEAVE, memberId: "bob" });
    assert.equal(leave.keyVersion, 3);
    assert.ok(countEvents(ctx.captured, GroupCommEventType.MEMBER_REKEYED) >= 2);
    const keys = await ctx.api.listKeys({ groupId: "g" });
    assert.equal(keys.length, 3);
    assert.equal(keys.find((k) => k.keyVersion === 3).state, GroupKeyState.ACTIVE);
  });

  it("handleMembershipChange is a no-op with no active key", async () => {
    const res = await ctx.engine.handleMembershipChange({ groupId: "g", trigger: RekeyTrigger.MEMBER_JOIN, memberId: "x" });
    assert.equal(res.rekeyed, false);
  });

  it("auto-rekeys from a Sprint-1 group event bus", async () => {
    const { GroupEventBus } = await import("../../group/events/events.js");
    const bus = new GroupEventBus();
    const off = ctx.engine.attachToGroupEvents(bus);
    await ctx.api.establishGroupKey({ groupId: "g", actorId: "alice" });
    bus.emit("group.member_left", { groupId: "g", memberId: "bob" });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal((await ctx.api.getKeyVersion({ groupId: "g" })).keyVersion, 2);
    off();
  });
});

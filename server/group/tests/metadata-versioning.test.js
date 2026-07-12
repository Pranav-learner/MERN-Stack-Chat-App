/**
 * Metadata management + version vector + version/metadata history (Layer 10, Sprint 1). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, countEvents } from "./helpers.js";
import { GroupEventType, VersionKind } from "../types/types.js";
import { createMetadata, applyMetadataPatch } from "../metadata/metadata.js";
import { createVersionVector, bumpVersion, compareVersionVectors } from "../versions/versionManager.js";

describe("metadata (pure)", () => {
  it("creates + validates metadata", () => {
    const m = createMetadata({ name: "  Hello  ", description: "d", tags: ["a", "a", "b"], visibility: "public" });
    assert.equal(m.name, "Hello");
    assert.deepEqual(m.tags, ["a", "b"]);
    assert.equal(m.version, 1);
    assert.throws(() => createMetadata({ name: "" }), /required/);
    assert.throws(() => createMetadata({ name: "x", visibility: "nope" }), /visibility/);
  });

  it("applies a partial patch + bumps version only when something changed", () => {
    const m = createMetadata({ name: "A" });
    const { metadata: m2, changed } = applyMetadataPatch(m, { description: "new" });
    assert.deepEqual(changed, ["description"]);
    assert.equal(m2.version, 2);
    const { metadata: m3, changed: none } = applyMetadataPatch(m2, { description: "new" });
    assert.deepEqual(none, [], "no-op patch changes nothing");
    assert.equal(m3.version, 2, "version unchanged on no-op");
  });
});

describe("version vector (pure)", () => {
  it("bumps the facet + the aggregate group counter", () => {
    const v0 = createVersionVector();
    const v1 = bumpVersion(v0, VersionKind.METADATA);
    assert.equal(v1.group, 2);
    assert.equal(v1.metadata, 2);
    assert.equal(v1.membership, 1, "unrelated facet untouched");
    assert.equal(v0.group, 1, "pure — original untouched");
  });

  it("compares vectors (equal / ahead / behind / diverged)", () => {
    const a = createVersionVector();
    const b = bumpVersion(a, VersionKind.MEMBERSHIP);
    assert.equal(compareVersionVectors(a, a), "equal");
    assert.equal(compareVersionVectors(b, a), "ahead");
    assert.equal(compareVersionVectors(a, b), "behind");
    const c = bumpVersion(a, VersionKind.METADATA); // ahead on metadata, behind on membership vs b
    assert.equal(compareVersionVectors(b, c), "diverged");
  });

  it("rejects an unknown version kind", () => {
    assert.throws(() => bumpVersion(createVersionVector(), "bogus"), /Unknown version kind/);
  });
});

describe("metadata through the manager", () => {
  let ctx, g;
  beforeEach(async () => {
    ctx = makeManager();
    g = await ctx.api.createGroup({ ownerId: "alice", metadata: { name: "A" }, initialMembers: [{ memberId: "bob" }] });
  });

  it("owner updates metadata; version + history advance", async () => {
    const updated = await ctx.api.updateMetadata({ groupId: g.groupId, actorId: "alice", patch: { name: "B", tags: ["x"] } });
    assert.equal(updated.metadata.name, "B");
    assert.equal(updated.metadata.version, 2);
    assert.ok(updated.versions.metadata > 1);
    assert.equal(countEvents(ctx.captured, GroupEventType.METADATA_UPDATED), 1);
    const hist = await ctx.api.getMetadataHistory({ groupId: g.groupId });
    assert.equal(hist.length, 1);
    assert.ok(hist[0].changed.includes("name"));
  });

  it("a member without EDIT_METADATA cannot update", async () => {
    await assert.rejects(() => ctx.api.updateMetadata({ groupId: g.groupId, actorId: "bob", patch: { name: "X" } }), /permission/i);
  });

  it("optimistic expectedVersion guard rejects a stale write", async () => {
    await ctx.api.updateMetadata({ groupId: g.groupId, actorId: "alice", patch: { name: "B" } }); // metadata v2
    await assert.rejects(() => ctx.api.updateMetadata({ groupId: g.groupId, actorId: "alice", patch: { name: "C" }, expectedVersion: 1 }), /stale/i);
    await ctx.api.updateMetadata({ groupId: g.groupId, actorId: "alice", patch: { name: "C" }, expectedVersion: 2 }); // correct version ok
  });

  it("version history captures aggregate bumps", async () => {
    await ctx.api.updateMetadata({ groupId: g.groupId, actorId: "alice", patch: { description: "d" } });
    const vh = await ctx.api.getVersionHistory({ groupId: g.groupId });
    assert.ok(vh.length >= 1);
    assert.ok(vh.every((e) => e.to > e.from));
  });
});

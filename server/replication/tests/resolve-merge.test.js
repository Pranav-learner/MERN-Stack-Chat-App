/**
 * Conflict resolution policies + the deterministic merge engine (Layer 9, Sprint 2). DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rec, snapshot, makeClock } from "./helpers.js";
import { ConflictResolver } from "../conflicts/conflictResolver.js";
import { mergeRecords, mergeReplicas, validateMerge, mergeFingerprint } from "../merge/mergeEngine.js";
import { ConflictPolicy } from "../types/types.js";
import { MergeError, UnresolvedConflictError } from "../errors.js";

const conflict = (category, s, t) => ({ category, entityId: "e1", source: { entityId: "e1", ...s }, target: { entityId: "e1", ...t } });

describe("conflict resolution policies", () => {
  it("last-write-wins picks the newest, ties by writer", () => {
    const r = new ConflictResolver();
    const res = r.resolve(conflict("messages", rec(2, "a", "hA", "2024-01-02T00:00:00Z"), rec(2, "b", "hB", "2024-01-01T00:00:00Z")), { policy: ConflictPolicy.LAST_WRITE_WINS });
    assert.equal(res.winner.contentHash, "hA");
    // tie → higher writer id
    const tie = r.resolve(conflict("messages", rec(2, "a", "hA", "2024-01-01T00:00:00Z"), rec(2, "b", "hB", "2024-01-01T00:00:00Z")), { policy: ConflictPolicy.LAST_WRITE_WINS });
    assert.equal(tie.winner.writerReplicaId, "b");
  });

  it("server-authority prefers the authority, falls back to LWW", () => {
    const r = new ConflictResolver({ authorityReplicaId: "server" });
    const res = r.resolve(conflict("messages", rec(2, "server", "srv", "2024-01-01T00:00:00Z"), rec(2, "phone", "ph", "2024-01-09T00:00:00Z")), { policy: ConflictPolicy.SERVER_AUTHORITY });
    assert.equal(res.winner.contentHash, "srv");
    assert.equal(res.reason, "authority-source");
    // neither is authority → fallback
    const fb = r.resolve(conflict("messages", rec(2, "a", "hA", "2024-01-02T00:00:00Z"), rec(2, "b", "hB", "2024-01-01T00:00:00Z")), { policy: ConflictPolicy.SERVER_AUTHORITY });
    assert.match(fb.reason, /fallback-lww/);
  });

  it("custom resolver decides; missing resolver throws", () => {
    const r = new ConflictResolver({ customResolvers: { messages: (c) => c.source } });
    assert.equal(r.resolve(conflict("messages", rec(2, "a", "hA"), rec(2, "b", "hB")), { policy: ConflictPolicy.CUSTOM }).winner.contentHash, "hA");
    const r2 = new ConflictResolver();
    assert.throws(() => r2.resolve(conflict("messages", rec(1, "a"), rec(1, "b")), { policy: ConflictPolicy.CUSTOM }), UnresolvedConflictError);
  });

  it("resolution is deterministic (same inputs → same winner)", () => {
    const r = new ConflictResolver();
    const c = conflict("messages", rec(2, "a", "hA", "2024-01-02T00:00:00Z"), rec(2, "b", "hB", "2024-01-01T00:00:00Z"));
    assert.equal(r.resolve(c, { policy: ConflictPolicy.LAST_WRITE_WINS }).winner.contentHash, r.resolve(c, { policy: ConflictPolicy.LAST_WRITE_WINS }).winner.contentHash);
  });
});

describe("merge engine — record strategies", () => {
  it("read receipts: union of readers, max readAt", () => {
    const a = { entityId: "r1", version: 1, writerReplicaId: "a", updatedAt: "2024-01-01T00:00:00Z", contentHash: "h", meta: { readers: { alice: "2024-01-01T00:00:00Z", bob: "2024-01-01T00:00:00Z" } } };
    const b = { entityId: "r1", version: 1, writerReplicaId: "b", updatedAt: "2024-01-02T00:00:00Z", contentHash: "g", meta: { readers: { bob: "2024-01-03T00:00:00Z", carol: "2024-01-02T00:00:00Z" } } };
    const m = mergeRecords("read-receipts", a, b);
    assert.deepEqual(Object.keys(m.meta.readers).sort(), ["alice", "bob", "carol"]);
    assert.equal(m.meta.readers.bob, "2024-01-03T00:00:00Z", "max readAt");
    assert.equal(m.writerReplicaId, "merge");
  });

  it("delivery: most-advanced state wins", () => {
    const m = mergeRecords("delivery", { entityId: "d1", version: 1, writerReplicaId: "a", updatedAt: "t", contentHash: "h", meta: { state: "sent" } }, { entityId: "d1", version: 1, writerReplicaId: "b", updatedAt: "t", contentHash: "g", meta: { state: "read" } });
    assert.equal(m.meta.state, "read");
  });

  it("attachments: field-wise (max size, prefer-defined mime)", () => {
    const m = mergeRecords("attachments", { entityId: "a1", version: 1, writerReplicaId: "a", updatedAt: "t", contentHash: "h", meta: { size: 100, mimeType: null, chunkCount: 2 } }, { entityId: "a1", version: 1, writerReplicaId: "b", updatedAt: "t", contentHash: "g", meta: { size: 250, mimeType: "image/png", chunkCount: 4 } });
    assert.equal(m.meta.size, 250);
    assert.equal(m.meta.chunkCount, 4);
    assert.equal(m.meta.mimeType, "image/png");
  });

  it("a merge is deterministic + commutative in fingerprint", () => {
    const a = { entityId: "r1", version: 2, writerReplicaId: "a", updatedAt: "2024-01-01T00:00:00Z", contentHash: "h", meta: { readers: { alice: "2024-01-01T00:00:00Z" } } };
    const b = { entityId: "r1", version: 3, writerReplicaId: "b", updatedAt: "2024-01-02T00:00:00Z", contentHash: "g", meta: { readers: { bob: "2024-01-02T00:00:00Z" } } };
    const m1 = mergeRecords("read-receipts", a, b);
    const m2 = mergeRecords("read-receipts", b, a);
    assert.equal(m1.contentHash, m2.contentHash, "commutative content");
    assert.equal(m1.version, m2.version);
  });
});

describe("merge engine — replica merge", () => {
  it("merges two replicas deterministically + is a superset", () => {
    const A = snapshot("A", { messages: { m1: rec(2, "A", "hA", "2024-01-02T00:00:00Z"), m2: rec(1, "A") }, "read-receipts": { r1: rec(1, "A", "x", "2024-01-01T00:00:00Z", { readers: { a: "2024-01-01T00:00:00Z" } }) } });
    const B = snapshot("B", { messages: { m1: rec(2, "B", "hB", "2024-01-01T00:00:00Z"), m3: rec(1, "B") }, "read-receipts": { r1: rec(1, "B", "y", "2024-01-02T00:00:00Z", { readers: { b: "2024-01-02T00:00:00Z" } }) } });
    const resolver = new ConflictResolver({ defaultPolicy: ConflictPolicy.LAST_WRITE_WINS });
    const r1 = mergeReplicas(A, B, { conflictResolver: resolver });
    const r2 = mergeReplicas(A, B, { conflictResolver: resolver });
    assert.equal(mergeFingerprint(r1.merged), mergeFingerprint(r2.merged), "deterministic");
    // superset: m1, m2, m3 all present.
    assert.equal(Object.keys(r1.merged.categories.messages).length, 3);
    // read receipt merged to union of a + b.
    assert.deepEqual(Object.keys(r1.merged.categories["read-receipts"].r1.meta.readers).sort(), ["a", "b"]);
    assert.ok(validateMerge(r1.merged, A, B));
  });

  it("supports a partial merge (category subset)", () => {
    const A = snapshot("A", { messages: { m1: rec(1, "A") }, delivery: { d1: rec(1, "A", "x", "t", { state: "sent" }) } });
    const B = snapshot("B", { messages: { m2: rec(1, "B") }, delivery: { d1: rec(1, "B", "y", "t", { state: "read" }) } });
    const resolver = new ConflictResolver();
    const r = mergeReplicas(A, B, { conflictResolver: resolver, categories: ["delivery"] });
    assert.equal(r.merged.categories.delivery.d1.meta.state, "read");
    assert.equal(Object.keys(r.merged.categories.messages ?? {}).length, 0, "messages not merged (partial)");
  });

  it("throws if a non-mergeable conflict has no resolver", () => {
    const A = snapshot("A", { messages: { m1: rec(2, "A", "hA") } });
    const B = snapshot("B", { messages: { m1: rec(2, "B", "hB") } });
    assert.throws(() => mergeReplicas(A, B, {}), MergeError);
  });
});

/**
 * Version stamps, replica model, and conflict detection (Layer 9, Sprint 2). DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rec, snapshot } from "./helpers.js";
import { compareStamps, nextVersion, mergedVersion, isVectorStamp, hashContent } from "../versions/versionStamp.js";
import { createReplicaSnapshot, applyRecord, getRecord, replicaSummary, normalizeRecord } from "../replicas/replicaModel.js";
import { classifyEntity, compareReplicas } from "../conflicts/conflictDetector.js";
import { StampOrder, ComparisonOutcome } from "../types/types.js";

describe("version stamps", () => {
  it("orders stamps: equal / dominates / dominated / concurrent", () => {
    assert.equal(compareStamps(rec(2, "a", "h"), rec(2, "a", "h")), StampOrder.EQUAL);
    assert.equal(compareStamps(rec(3, "a", "h"), rec(2, "a", "g")), StampOrder.DOMINATES);
    assert.equal(compareStamps(rec(1, "a", "h"), rec(2, "a", "g")), StampOrder.DOMINATED);
    assert.equal(compareStamps(rec(2, "a", "hA"), rec(2, "b", "hB")), StampOrder.CONCURRENT);
  });

  it("increments + merges versions monotonically", () => {
    const v = nextVersion(rec(4, "a", "h"), { writerReplicaId: "a", updatedAt: "t", contentHash: "h2" });
    assert.equal(v.version, 5);
    assert.equal(mergedVersion(rec(3), rec(7)), 8);
  });

  it("is a scalar stamp this sprint (vector-clock seam is documented, not built)", () => {
    assert.equal(isVectorStamp(), false);
    assert.equal(hashContent({ a: 1, b: 2 }), hashContent({ b: 2, a: 1 }), "stable hash regardless of key order");
  });
});

describe("replica model", () => {
  it("normalizes a bare number (Sprint-1 compatible) into a full record", () => {
    const r = normalizeRecord("m1", 3);
    assert.equal(r.version, 3);
    assert.equal(r.entityId, "m1");
  });

  it("applyRecord adopts a dominating record, ignores a dominated one", () => {
    let s = createReplicaSnapshot({ deviceId: "d", userId: "u", categories: { messages: { m1: rec(2, "d", "h2") } } });
    let res = applyRecord(s, "messages", { entityId: "m1", ...rec(3, "d", "h3") });
    assert.equal(res.changed, true);
    assert.equal(getRecord(res.snapshot, "messages", "m1").version, 3);
    res = applyRecord(res.snapshot, "messages", { entityId: "m1", ...rec(1, "d", "h1") });
    assert.equal(res.changed, false, "no regression");
  });

  it("summary carries per-category counts, no raw records", () => {
    const s = snapshot("r1", { messages: { m1: rec(1, "r1"), m2: rec(1, "r1") } });
    const sum = replicaSummary(s);
    assert.equal(sum.categories.messages.count, 2);
    assert.equal(sum.categories.messages.entities, undefined);
  });
});

describe("conflict detection", () => {
  it("classifies each entity pairing", () => {
    assert.equal(classifyEntity("messages", rec(1, "a"), null).outcome, ComparisonOutcome.ONLY_IN_SOURCE);
    assert.equal(classifyEntity("messages", null, rec(1, "a")).outcome, ComparisonOutcome.ONLY_IN_TARGET);
    assert.equal(classifyEntity("messages", rec(2, "a", "h"), rec(2, "a", "h")).outcome, ComparisonOutcome.IN_SYNC);
    assert.equal(classifyEntity("messages", rec(3, "a", "h"), rec(2, "a", "g")).outcome, ComparisonOutcome.FAST_FORWARD_TARGET);
    assert.equal(classifyEntity("messages", rec(2, "a", "hA"), rec(2, "b", "hB")).outcome, ComparisonOutcome.CONFLICT);
    // mergeable categories → MERGE (not conflict) when they differ.
    assert.equal(classifyEntity("read-receipts", rec(2, "a", "hA"), rec(2, "b", "hB")).outcome, ComparisonOutcome.MERGE);
  });

  it("compareReplicas totals divergence deterministically", () => {
    const A = snapshot("A", { messages: { m1: rec(2, "A", "hA"), m2: rec(1, "A"), m3: rec(1, "A") }, "read-receipts": { r1: rec(1, "A", "x") } });
    const B = snapshot("B", { messages: { m1: rec(2, "B", "hB"), m2: rec(1, "A") }, "read-receipts": { r1: rec(1, "B", "y") } });
    const cmp = compareReplicas(A, B);
    assert.equal(cmp.totals.conflicts, 1, "m1 conflict");
    assert.equal(cmp.totals.inSync, 1, "m2 in sync");
    assert.equal(cmp.totals.onlyInSource, 1, "m3 only in A");
    assert.equal(cmp.totals.merges, 1, "read receipt merge");
    // deterministic
    assert.deepEqual(compareReplicas(A, B).totals, cmp.totals);
  });
});

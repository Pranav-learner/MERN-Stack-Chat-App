/**
 * Replica state + delta detection (Layer 9, Sprint 1): version maps, monotonic merges, and the
 * "what is missing?" diff (initial, incremental, per-category, deterministic). DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { versions } from "./helpers.js";
import { createReplica, applyEntityVersions, normalizeCategoryVersions, categoryHighWater, replicaSummary } from "../state/replicaState.js";
import { computeDelta, estimateDeltaBytes, isDeltaEmpty, validateDelta, compressDelta } from "../delta/deltaDetector.js";
import { SyncCategory } from "../types/types.js";
import { MalformedDeltaError } from "../errors.js";

describe("replica state", () => {
  it("normalizes category versions + computes high-water", () => {
    const cv = normalizeCategoryVersions(versions({ messages: { m1: 3, m2: 7 } }));
    assert.equal(cv.messages.version, 7);
    assert.equal(categoryHighWater(cv.messages.entities), 7);
    // all categories present
    assert.ok(cv[SyncCategory.CONVERSATIONS]);
  });

  it("applyEntityVersions advances monotonically (never regresses)", () => {
    let cv = normalizeCategoryVersions(versions({ messages: { m1: 5 } }));
    cv = applyEntityVersions(cv, "messages", [{ entityId: "m1", version: 3 }, { entityId: "m2", version: 2 }]);
    assert.equal(cv.messages.entities.m1, 5, "m1 not regressed");
    assert.equal(cv.messages.entities.m2, 2, "m2 learned");
    cv = applyEntityVersions(cv, "messages", [{ entityId: "m1", version: 9 }]);
    assert.equal(cv.messages.entities.m1, 9, "m1 advanced");
  });

  it("createReplica + summary carry no raw entity dumps", () => {
    const r = createReplica({ deviceId: "d1", userId: "u1", categoryVersions: versions({ messages: { m1: 1, m2: 1 } }) });
    const s = replicaSummary(r);
    assert.equal(s.categories.messages.count, 2);
    assert.equal(s.deviceId, "d1");
    assert.equal(s.categories.messages.entities, undefined);
  });
});

describe("delta detection", () => {
  const source = createReplica({ deviceId: "phone", userId: "u1", categoryVersions: versions({ conversations: { c1: 3, c2: 1 }, messages: { m1: 1, m2: 2, m3: 1 } }) });
  const target = createReplica({ deviceId: "laptop", userId: "u1", categoryVersions: versions({ conversations: { c1: 2 }, messages: { m1: 1 } }) });

  it("computes exactly what the target is missing or has stale", () => {
    const delta = computeDelta(source, target);
    assert.equal(delta.categories.conversations.count, 2, "c1 stale + c2 missing");
    assert.equal(delta.categories.messages.count, 2, "m2 (stale) + m3 (missing)");
    assert.equal(delta.totalItems, 4);
    assert.equal(isDeltaEmpty(delta), false);
  });

  it("is deterministic (sorted entity refs)", () => {
    const a = computeDelta(source, target);
    const b = computeDelta(source, target);
    assert.deepEqual(a.categories.messages.missing, b.categories.messages.missing);
    assert.deepEqual(a.categories.messages.missing.map((r) => r.entityId), ["m2", "m3"]);
  });

  it("supports incremental sync via a per-category cursor", () => {
    const delta = computeDelta(source, target, { since: { messages: 1 } }); // only messages with version > 1
    assert.deepEqual(delta.categories.messages.missing.map((r) => r.entityId), ["m2"]);
  });

  it("supports a category filter", () => {
    const delta = computeDelta(source, target, { categories: ["messages"] });
    assert.equal(delta.categories.conversations, undefined);
    assert.equal(delta.totalItems, 2);
  });

  it("is empty when the target already has everything", () => {
    const delta = computeDelta(source, source);
    assert.equal(isDeltaEmpty(delta), true);
  });

  it("estimates bytes + validates shape; rejects malformed", () => {
    const delta = computeDelta(source, target);
    assert.ok(estimateDeltaBytes(delta) > 0);
    assert.ok(validateDelta(delta));
    assert.equal(compressDelta(delta), delta); // inert placeholder
    assert.throws(() => validateDelta({ categories: { bogus: { missing: [] } } }), MalformedDeltaError);
    assert.throws(() => computeDelta({}, target), MalformedDeltaError);
  });
});

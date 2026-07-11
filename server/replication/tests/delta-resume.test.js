/**
 * Delta replication, replay protection, and transfer/resume (Layer 9, Sprint 2). DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rec, snapshot } from "./helpers.js";
import { generateReplicationDelta, applyDelta, validateDelta, deltaChecksum, resumeDelta, planTransferResume, compressDelta, ReplayGuard } from "../delta/deltaReplicator.js";
import { CorruptedDeltaError, ReplayDetectedError } from "../errors.js";

describe("delta generation", () => {
  it("carries only what the target lacks or is behind on", () => {
    const source = snapshot("s", { messages: { m1: rec(1, "s"), m2: rec(1, "s"), m3: rec(2, "s", "hi") } });
    const target = snapshot("t", { messages: { m1: rec(1, "s"), m3: rec(1, "s", "lo") } });
    const delta = generateReplicationDelta(source, target);
    const ids = delta.records.map((r) => r.record.entityId).sort();
    assert.deepEqual(ids, ["m2", "m3"], "m2 missing + m3 stale; m1 in sync excluded");
    assert.ok(validateDelta(delta));
    assert.equal(delta.checksum, deltaChecksum(delta));
  });

  it("truncates a huge delta into a partial one", () => {
    const entities = {};
    for (let i = 0; i < 50; i++) entities[`m${i}`] = rec(1, "s");
    const delta = generateReplicationDelta(snapshot("s", { messages: entities }), snapshot("t", {}), { maxItems: 10 });
    assert.equal(delta.totalItems, 10);
    assert.equal(delta.partial, true);
  });

  it("rejects a corrupted / tampered delta", () => {
    const delta = generateReplicationDelta(snapshot("s", { messages: { m1: rec(1, "s") } }), snapshot("t", {}));
    delta.checksum = "tampered";
    assert.throws(() => validateDelta(delta), CorruptedDeltaError);
    assert.equal(compressDelta(delta), delta); // inert
  });
});

describe("delta application", () => {
  it("applies missing records monotonically (no overwrite of divergent)", () => {
    const source = snapshot("s", { messages: { m1: rec(2, "s", "hS"), m2: rec(1, "s") } });
    const target = snapshot("t", { messages: { m1: rec(2, "t", "hT") } }); // m1 diverges (concurrent)
    const delta = generateReplicationDelta(source, target);
    const { snapshot: out, applied } = applyDelta(target, delta);
    assert.equal(out.categories.messages.m2.version, 1, "m2 replicated");
    assert.equal(out.categories.messages.m1.contentHash, "hT", "divergent m1 NOT overwritten by raw delta");
    assert.ok(applied >= 1);
  });

  it("merges mergeable-category records on apply (lossless)", () => {
    const source = snapshot("s", { "read-receipts": { r1: rec(1, "s", "x", "2024-01-02T00:00:00Z", { readers: { a: "2024-01-02T00:00:00Z" } }) } });
    const target = snapshot("t", { "read-receipts": { r1: rec(1, "t", "y", "2024-01-01T00:00:00Z", { readers: { b: "2024-01-01T00:00:00Z" } }) } });
    const delta = generateReplicationDelta(source, target);
    const { snapshot: out } = applyDelta(target, delta);
    assert.deepEqual(Object.keys(out.categories["read-receipts"].r1.meta.readers).sort(), ["a", "b"], "union merge on apply");
  });
});

describe("replay protection", () => {
  it("rejects re-applying the same delta id", () => {
    const guard = new ReplayGuard();
    assert.equal(guard.check("delta-1"), true);
    assert.throws(() => guard.check("delta-1"), ReplayDetectedError);
    assert.equal(guard.has("delta-1"), true);
  });
});

describe("resume + transfer resume", () => {
  it("resumes a delta from a cursor (partial-transfer recovery)", () => {
    const entities = {};
    for (let i = 0; i < 6; i++) entities[`m${i}`] = rec(1, "s");
    const delta = generateReplicationDelta(snapshot("s", { messages: entities }), snapshot("t", {}));
    const resumed = resumeDelta(delta, 4);
    assert.equal(resumed.records.length, delta.records.length - 4);
    assert.equal(resumed.resumedFrom, 4);
  });

  it("plans Layer-8 transfer resume for large attachment entities", () => {
    const source = snapshot("s", { attachments: { a1: rec(1, "s", "h", "t", { transferId: "xfer-1", checkpoint: { highWaterMark: 10 }, size: 5_000_000 }) } });
    const delta = generateReplicationDelta(source, snapshot("t", {}));
    let resumed = null;
    const plan = planTransferResume(delta, { transferHooks: { resume: (e) => { resumed = e; return { resumeFrom: e.checkpoint.highWaterMark }; } } });
    assert.equal(plan.resumable, true);
    assert.equal(plan.transfers[0].transferId, "xfer-1");
    assert.equal(plan.transfers[0].plan.resumeFrom, 10);
    assert.equal(resumed.transferId, "xfer-1");
  });
});

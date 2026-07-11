/**
 * Replica manager end-to-end (Layer 9, Sprint 2): register/update, compare, synchronize (with conflict
 * resolution + merge, converging BOTH replicas), explicit resolve, delta replication, resume, version +
 * conflict history, multi-device convergence, and ownership. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, rec, countEvents } from "./helpers.js";
import { ReplicationEventType, ConflictPolicy } from "../types/types.js";

describe("replica lifecycle", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("registers idempotently + applies monotonic updates", async () => {
    await ctx.manager.registerReplica({ deviceId: "phone", userId: "u1", replicaId: "rP", categories: { messages: { m1: rec(1, "rP") } } });
    const again = await ctx.manager.registerReplica({ deviceId: "phone", userId: "u1", replicaId: "rP", categories: { messages: { m2: rec(1, "rP") } } });
    assert.equal(again.categories.messages.count, 2, "second register merges in m2");
    const upd = await ctx.manager.updateReplica("rP", { categories: { messages: { m1: rec(3, "rP", "h3") } } });
    assert.equal(upd.categories.messages.version, 3);
    assert.equal(countEvents(ctx.captured, ReplicationEventType.REPLICA_REGISTERED), 1);
    assert.ok(countEvents(ctx.captured, ReplicationEventType.REPLICA_UPDATED) >= 1);
  });
});

describe("synchronization + conflict resolution", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("converges both replicas, resolving a message conflict by last-write-wins", async () => {
    await ctx.manager.registerReplica({ deviceId: "a", userId: "u1", replicaId: "rA", categories: { messages: { m1: rec(2, "rA", "hA", "2024-01-02T00:00:00Z"), m2: rec(1, "rA") } } });
    await ctx.manager.registerReplica({ deviceId: "b", userId: "u1", replicaId: "rB", categories: { messages: { m1: rec(2, "rB", "hB", "2024-01-01T00:00:00Z"), m3: rec(1, "rB") } } });

    const result = await ctx.manager.synchronizeReplicas({ sourceReplicaId: "rA", targetReplicaId: "rB", policy: ConflictPolicy.LAST_WRITE_WINS });
    assert.equal(result.comparison.totals.conflicts, 1);
    assert.equal(result.resolutions[0].winner.contentHash, "hA", "newer wins");
    assert.equal(countEvents(ctx.captured, ReplicationEventType.CONFLICT_DETECTED), 1);
    assert.equal(countEvents(ctx.captured, ReplicationEventType.CONFLICT_RESOLVED), 1);
    assert.equal(countEvents(ctx.captured, ReplicationEventType.MERGE_COMPLETED), 1);

    // BOTH replicas converge: m1 (=hA), m2, m3 on each.
    const a = await ctx.manager.getReplicaStatus({ replicaId: "rA" });
    const b = await ctx.manager.getReplicaStatus({ replicaId: "rB" });
    assert.equal(a.categories.messages.count, 3);
    assert.equal(b.categories.messages.count, 3);
    // a follow-up compare shows no divergence.
    const cmp = await ctx.manager.compareReplicas({ sourceReplicaId: "rA", targetReplicaId: "rB" });
    assert.equal(cmp.totals.conflicts + cmp.totals.onlyInSource + cmp.totals.onlyInTarget, 0);
  });

  it("server-authority resolution", async () => {
    const ctx2 = makeManager({ authorityReplicaId: "server" });
    await ctx2.manager.registerReplica({ deviceId: "server", userId: "u1", replicaId: "server", categories: { messages: { m1: rec(2, "server", "srv", "2024-01-01T00:00:00Z") } } });
    await ctx2.manager.registerReplica({ deviceId: "phone", userId: "u1", replicaId: "rP", categories: { messages: { m1: rec(2, "rP", "ph", "2024-01-09T00:00:00Z") } } });
    const r = await ctx2.manager.synchronizeReplicas({ sourceReplicaId: "server", targetReplicaId: "rP", policy: ConflictPolicy.SERVER_AUTHORITY });
    assert.equal(r.resolutions[0].winner.contentHash, "srv");
  });

  it("read receipts + delivery merge losslessly (no conflict)", async () => {
    await ctx.manager.registerReplica({ deviceId: "a", userId: "u1", replicaId: "rA", categories: { "read-receipts": { r1: rec(1, "rA", "x", "2024-01-01T00:00:00Z", { readers: { alice: "2024-01-01T00:00:00Z" } }) }, delivery: { d1: rec(1, "rA", "s", "t", { state: "sent" }) } } });
    await ctx.manager.registerReplica({ deviceId: "b", userId: "u1", replicaId: "rB", categories: { "read-receipts": { r1: rec(1, "rB", "y", "2024-01-02T00:00:00Z", { readers: { bob: "2024-01-02T00:00:00Z" } }) }, delivery: { d1: rec(1, "rB", "r", "t", { state: "read" }) } } });
    await ctx.manager.synchronizeReplicas({ sourceReplicaId: "rA", targetReplicaId: "rB" });
    const diag = await ctx.manager.getDiagnostics({ replicaId: "rB" });
    assert.equal(diag.recentConflicts.length, 0, "mergeable categories never conflict");
    const cmp = await ctx.manager.compareReplicas({ sourceReplicaId: "rA", targetReplicaId: "rB" });
    assert.equal(cmp.totals.merges, 0, "converged");
  });

  it("explicitly resolves a single conflict + records history", async () => {
    await ctx.manager.registerReplica({ deviceId: "a", userId: "u1", replicaId: "rA", categories: { messages: { m1: rec(2, "rA", "hA", "2024-01-02T00:00:00Z") } } });
    await ctx.manager.registerReplica({ deviceId: "b", userId: "u1", replicaId: "rB", categories: { messages: { m1: rec(2, "rB", "hB", "2024-01-01T00:00:00Z") } } });
    const res = await ctx.manager.resolveConflict({ sourceReplicaId: "rA", targetReplicaId: "rB", category: "messages", entityId: "m1", policy: ConflictPolicy.LAST_WRITE_WINS });
    assert.equal(res.winner.contentHash, "hA");
    const history = await ctx.manager.getConflictHistory({ replicaId: "rA" });
    assert.ok(history.length >= 1);
  });
});

describe("delta replication + resume + history", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("replicates a delta (catch-up) with replay protection", async () => {
    await ctx.manager.registerReplica({ deviceId: "s", userId: "u1", replicaId: "s", categories: { messages: { m1: rec(1, "s"), m2: rec(1, "s"), m3: rec(1, "s") } } });
    await ctx.manager.registerReplica({ deviceId: "t", userId: "u1", replicaId: "t", categories: { messages: { m1: rec(1, "s") } } });
    const r = await ctx.manager.replicateDelta({ sourceReplicaId: "s", targetReplicaId: "t" });
    assert.equal(r.applied, 2);
    assert.equal((await ctx.manager.getReplicaStatus({ replicaId: "t" })).categories.messages.count, 3);
    // replay: same delta id can't be applied again.
    await assert.rejects(() => ctx.manager.replicateDelta({ sourceReplicaId: "s", targetReplicaId: "t", maxItems: 3 }).then(() => ctx.manager.replayGuard.check(r.delta.deltaId)), /already applied/);
  });

  it("resumes an interrupted synchronization from a cursor", async () => {
    const entities = {};
    for (let i = 0; i < 8; i++) entities[`m${i}`] = rec(1, "s");
    await ctx.manager.registerReplica({ deviceId: "s", userId: "u1", replicaId: "s", categories: { messages: entities } });
    await ctx.manager.registerReplica({ deviceId: "t", userId: "u1", replicaId: "t", categories: {} });
    const r = await ctx.manager.resumeSynchronization({ sourceReplicaId: "s", targetReplicaId: "t", cursor: 3 });
    assert.equal(r.resumedItems, 5, "resumes the remaining 5");
    assert.equal(countEvents(ctx.captured, ReplicationEventType.SYNCHRONIZATION_RESUMED), 1);
  });

  it("tracks version history", async () => {
    await ctx.manager.registerReplica({ deviceId: "a", userId: "u1", replicaId: "rA", categories: { messages: { m1: rec(1, "rA") } } });
    await ctx.manager.updateReplica("rA", { categories: { messages: { m1: rec(2, "rA", "h2") } } });
    const history = await ctx.manager.getVersionHistory({ replicaId: "rA", category: "messages", entityId: "m1" });
    assert.ok(history.length >= 1);
    assert.equal(history[0].version, 2);
  });
});

describe("multiple devices + ownership", () => {
  it("converges three devices to a common state", async () => {
    const ctx = makeManager();
    await ctx.manager.registerReplica({ deviceId: "server", userId: "u1", replicaId: "server", categories: { messages: { m1: rec(1, "server"), m2: rec(1, "server") } } });
    for (const d of ["phone", "laptop"]) {
      await ctx.manager.registerReplica({ deviceId: d, userId: "u1", replicaId: d, categories: {} });
      await ctx.manager.synchronizeReplicas({ sourceReplicaId: "server", targetReplicaId: d });
      assert.equal((await ctx.manager.getReplicaStatus({ replicaId: d })).categories.messages.count, 2);
    }
  });

  it("owner-scopes replica access", async () => {
    const ctx = makeManager();
    await ctx.manager.registerReplica({ deviceId: "phone", userId: "u1", replicaId: "rP", categories: {} });
    await assert.rejects(() => ctx.manager.updateReplica("rP", { categories: {} }, { actingDevice: "mallory" }), /does not own/);
    await assert.rejects(() => ctx.manager.getReplicaStatus({ replicaId: "rP", actingDevice: "mallory" }), /does not own/);
  });

  it("rejects a plaintext-bearing record", async () => {
    const ctx = makeManager();
    await assert.rejects(
      () => ctx.manager.registerReplica({ deviceId: "x", userId: "u1", categories: { messages: { m1: { version: 1, writerReplicaId: "x", plaintext: "leak" } } } }),
      /plaintext|secret|content/i,
    );
  });
});

/**
 * Media synchronization + transfer optimization + repository + concurrency (Layer 11, Sprint 2):
 * availability delta, offline queue, resume sync, priority scheduling, parallel slots, bandwidth,
 * concurrent transfers, repository contracts. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeEngine, uploadMedia } from "./helpers.js";
import { MediaDeliveryEventType, TransferPriority } from "../types/types.js";
import { buildAvailabilityReplica, computeMediaDelta, createMediaSyncPlan, markAvailable } from "../synchronization/mediaSync.js";
import { TransferScheduler } from "../optimization/transferOptimizer.js";
import { createInMemoryDeliveryRepository } from "../repository/inMemoryDeliveryRepository.js";

describe("media sync (pure, reuses Layer 9 delta model)", () => {
  it("computes the missing delta + a resumable plan", () => {
    const replica = buildAvailabilityReplica({ deviceId: "d", available: ["a", "b"] });
    const delta = computeMediaDelta(replica, ["a", "b", "c", "d"]);
    assert.deepEqual(delta.missing.sort(), ["c", "d"]);
    assert.deepEqual(delta.available.sort(), ["a", "b"]);
    assert.equal(delta.upToDate, false);
    const plan = createMediaSyncPlan({ deviceId: "d", delta });
    assert.equal(plan.total, 2);
    assert.equal(plan.operations[0].action, "fetch");
  });

  it("markAvailable is monotonic + updates the fingerprint", () => {
    let r = buildAvailabilityReplica({ deviceId: "d", available: ["a"] });
    const fp = r.fingerprint;
    r = markAvailable(r, "b");
    assert.equal(r.availableCount, 2);
    assert.notEqual(r.fingerprint, fp);
    const same = markAvailable(r, "b");
    assert.equal(same, r, "adding an existing media is a no-op");
  });
});

describe("media sync through the engine", () => {
  let ctx;
  beforeEach(() => {
    ctx = makeEngine();
  });

  it("synchronizes a device, queues offline fetches, and marks available", async () => {
    const m1 = await uploadMedia(ctx.mediaManager, Buffer.alloc(100));
    await ctx.api.registerAvailability({ deviceId: "phone", actorId: "alice", available: [m1.mediaId] });
    const sync = await ctx.api.synchronizeDevice({ deviceId: "tablet", actorId: "alice", authoritativeMedia: [m1.mediaId, "media-x", "media-y"] });
    assert.equal(sync.plan.total, 3, "tablet missing all 3");
    assert.equal((await ctx.api.getOfflineQueue({ deviceId: "tablet" })).length, 3);
    assert.equal(countEvents(ctx.captured, MediaDeliveryEventType.MEDIA_SYNCHRONIZED), 1);
    assert.equal(countEvents(ctx.captured, MediaDeliveryEventType.OFFLINE_MEDIA_QUEUED), 3);
    const replica = await ctx.api.markMediaAvailable({ deviceId: "tablet", mediaId: m1.mediaId, actorId: "alice" });
    assert.ok(replica.available.includes(m1.mediaId));
    assert.equal(countEvents(ctx.captured, MediaDeliveryEventType.MEDIA_AVAILABLE), 1);
  });
});

function countEvents(list, type) {
  return list.filter((e) => e.type === type).length;
}

describe("transfer optimization", () => {
  it("schedules by priority, respects parallel slots, tracks bandwidth", () => {
    let now = 0;
    const s = new TransferScheduler({ parallel: 2, clock: () => now });
    s.enqueue({ transferId: "low", priority: TransferPriority.LOW });
    now = 1;
    s.enqueue({ transferId: "high", priority: TransferPriority.HIGH });
    now = 2;
    s.enqueue({ transferId: "normal", priority: TransferPriority.NORMAL });
    const first = s.schedule();
    assert.deepEqual(first, ["high", "normal"], "highest priority first, then normal (2 slots)");
    s.complete("high");
    const second = s.schedule();
    assert.deepEqual(second, ["low"], "low runs after a slot frees");
    s.recordBytes(1000);
    assert.equal(s.bandwidth().totalBytes, 1000);
    assert.ok(s.stats().optimizations >= 2);
  });

  it("prefetch plan marks candidates prefetch-priority", () => {
    const s = new TransferScheduler();
    const plan = s.prefetchPlan(["a", "b"]);
    assert.equal(plan.length, 2);
    assert.equal(plan[0].priority, TransferPriority.PREFETCH);
  });

  it("engine optimize tick starts scheduled transfers", async () => {
    const ctx = makeEngine({ parallel: 2 });
    const media = await uploadMedia(ctx.mediaManager, Buffer.alloc(100));
    await ctx.api.startTransfer({ mediaId: media.mediaId, deviceId: "a", actorId: "a", direction: "download", priority: "high" });
    await ctx.api.startTransfer({ mediaId: media.mediaId, deviceId: "b", actorId: "b", direction: "download", priority: "low" });
    const opt = await ctx.api.optimizeTransfers();
    assert.ok(opt.started.length >= 1);
    assert.ok((await ctx.api.bandwidthMetrics()) !== null);
  });
});

describe("concurrency + repository", () => {
  it("concurrent chunk fetches on the same transfer never lose or double-count", async () => {
    const ctx = makeEngine({ chunkSize: 64 * 1024 });
    const media = await uploadMedia(ctx.mediaManager, Buffer.alloc(640 * 1024, 1)); // 10 chunks
    const { transfer } = await ctx.api.startTransfer({ mediaId: media.mediaId, deviceId: "laptop", actorId: "laptop", direction: "download" });
    await Promise.all(Array.from({ length: 10 }, (_, i) => ctx.api.fetchChunk({ transferId: transfer.transferId, index: i, actorId: "laptop" })));
    const status = await ctx.api.getTransferStatus({ transferId: transfer.transferId });
    assert.equal(status.deliveredChunks, 10);
    assert.equal(status.state, "completed");
  });

  it("in-memory repository contracts", async () => {
    const repo = createInMemoryDeliveryRepository();
    await repo.sessions.create({ sessionId: "s", mediaId: "m", deviceId: "d", state: "idle", createdAt: "t" });
    const s = await repo.sessions.findById("s");
    s.state = "MUTATED";
    assert.equal((await repo.sessions.findById("s")).state, "idle", "deep-copied");
    await repo.transfers.create({ transferId: "t1", mediaId: "m", direction: "download", deviceId: "d", state: "pending", createdAt: "t" });
    assert.equal((await repo.transfers.listByMedia("m")).length, 1);
    await repo.availability.enqueueOffline({ deviceId: "d", mediaId: "m1" });
    await repo.availability.enqueueOffline({ deviceId: "d", mediaId: "m2" });
    assert.equal((await repo.availability.drainOffline("d")).length, 2);
    assert.equal(await repo.availability.countOffline("d"), 0);
  });
});

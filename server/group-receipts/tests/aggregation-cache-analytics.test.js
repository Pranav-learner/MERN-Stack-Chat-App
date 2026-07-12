/**
 * Incremental aggregation + cache + analytics + repository + validation (Layer 10, Sprint 4). DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, seedMessage, deliver, read } from "./helpers.js";
import { createAggregate, applyDeliveryDelta, applyReadDelta, aggregateCounts } from "../aggregation/aggregator.js";
import { computeAnalytics } from "../analytics/analytics.js";
import { ReceiptCache } from "../cache/receiptCache.js";
import { createInMemoryReceiptRepository } from "../repository/inMemoryReceiptRepository.js";
import { assertNoContent, validateAggregateInvariants, validateRepository, validateRegister } from "../validators/validators.js";

describe("incremental aggregator (pure)", () => {
  it("delivery delta increments once + flags full delivery", () => {
    let agg = createAggregate({ messageId: "m", groupId: "g", applicableMembers: ["a", "b"] });
    let r = applyDeliveryDelta(agg, { latencyMs: 100 });
    assert.equal(r.aggregate.deliveredCount, 1);
    assert.equal(r.fullyDelivered, false);
    r = applyDeliveryDelta(r.aggregate, { latencyMs: 200 });
    assert.equal(r.aggregate.deliveredCount, 2);
    assert.equal(r.fullyDelivered, true, "second delivery completes the group");
    assert.equal(r.aggregate.deliveryLatencySumMs, 300);
  });

  it("read delta can carry a first delivery + flags full read", () => {
    let agg = createAggregate({ messageId: "m", groupId: "g", applicableMembers: ["a", "b"] });
    let r = applyReadDelta(agg, { becameDelivered: true, readLatencyMs: 50 });
    assert.equal(r.aggregate.deliveredCount, 1);
    assert.equal(r.aggregate.readCount, 1);
    r = applyReadDelta(r.aggregate, { becameDelivered: true });
    assert.equal(r.fullyRead, true);
    assert.equal(r.fullyDelivered, true);
  });

  it("counts view is O(1) + derives pending/waiting/unread", () => {
    const agg = { applicableCount: 10, readApplicableCount: 10, deliveredCount: 7, readCount: 3, failedCount: 1 };
    const c = aggregateCounts(agg);
    assert.deepEqual({ pending: c.pending, waiting: c.waiting, unread: c.unread }, { pending: 3, waiting: 3, unread: 7 });
  });
});

describe("analytics (pure)", () => {
  it("computes percentages + averaged latencies from the aggregate (O(1))", () => {
    const agg = createAggregate({ messageId: "m", groupId: "g", applicableMembers: ["a", "b", "c", "d"] });
    const withData = { ...agg, deliveredCount: 3, readCount: 2, deliveryLatencySumMs: 600, deliveryLatencyCount: 3, readLatencySumMs: 400, readLatencyCount: 2 };
    const a = computeAnalytics(withData);
    assert.equal(a.deliveryPercentage, 75);
    assert.equal(a.readPercentage, 50);
    assert.equal(a.avgDeliveryLatencyMs, 200);
    assert.equal(a.avgReadLatencyMs, 200);
  });
});

describe("receipt cache", () => {
  it("caches with TTL + LRU eviction + hit/miss stats", async () => {
    const clock = { t: 0, now() { return this.t; } };
    const cache = new ReceiptCache({ clock: () => clock.now(), ttlMs: 100, max: 2 });
    await cache.set("a", { tick: "single" });
    assert.deepEqual(await cache.get("a"), { tick: "single" });
    clock.t = 200; // expire
    assert.equal(await cache.get("a"), null);
    await cache.set("x", { v: 1 });
    await cache.set("y", { v: 2 });
    await cache.set("z", { v: 3 }); // evicts x (LRU, max 2)
    assert.equal(await cache.get("x"), null);
    assert.ok(cache.stats().evictions >= 1);
  });

  it("uses distributed cache hooks as an L2 (fail-open)", async () => {
    const remote = new Map();
    const cache = new ReceiptCache({ distributed: { get: async (k) => remote.get(k) ?? null, set: async (k, v) => remote.set(k, v), del: async (k) => remote.delete(k) } });
    await cache.set("a", { tick: "grey-double" });
    assert.ok(remote.has("a"), "write-through to L2");
    cache.clear(); // drop L1
    assert.deepEqual(await cache.get("a"), { tick: "grey-double" }, "served from L2");
  });

  it("the manager cache-fronts receipt reads", async () => {
    const ctx = makeManager();
    const m = await seedMessage(ctx.manager, { members: ["alice", "bob"] });
    await deliver(ctx.manager, m, "bob");
    await ctx.manager.getReceipt(m);
    await ctx.manager.getReceipt(m); // second read is a cache hit
    assert.ok(ctx.cache.stats().hits >= 1);
  });
});

describe("repository + validation", () => {
  let repo;
  beforeEach(() => {
    repo = createInMemoryReceiptRepository();
  });

  it("aggregates + memberReceipts stores work + filter", async () => {
    await repo.aggregates.create({ messageId: "m", groupId: "g", applicableMembers: ["a", "b"], sentAt: "t" });
    assert.equal((await repo.aggregates.findById("m")).groupId, "g");
    await repo.memberReceipts.upsert({ messageId: "m", memberId: "a", memberDelivered: true, memberRead: true });
    await repo.memberReceipts.upsert({ messageId: "m", memberId: "b", memberDelivered: true, memberRead: false });
    assert.equal((await repo.memberReceipts.listByMessage("m", { filter: "read" })).length, 1);
    assert.equal(await repo.memberReceipts.countByMessage("m", "delivered"), 2);
  });

  it("deep-copies records (no mutation by reference)", async () => {
    await repo.aggregates.create({ messageId: "m", groupId: "g", deliveredCount: 0 });
    const a = await repo.aggregates.findById("m");
    a.deliveredCount = 999;
    assert.equal((await repo.aggregates.findById("m")).deliveredCount, 0);
  });

  it("rejects content/secret material + invalid aggregates", () => {
    assert.throws(() => assertNoContent({ policy: { ciphertext: "x" } }), /content\/secret/i);
    assert.throws(() => validateAggregateInvariants({ deliveredCount: 5, applicableCount: 2 }), /cannot exceed/i);
    assert.throws(() => validateRegister({ messageId: "m", groupId: "g", applicableMembers: "nope" }), /must be an array/i);
    assert.throws(() => validateRepository({}), /missing the 'aggregates'/i);
  });
});

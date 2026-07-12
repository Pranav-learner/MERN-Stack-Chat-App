/**
 * WhatsApp tick logic + receipt policy (Layer 10, Sprint 4): single/grey/blue transitions, member
 * exclusions, read-receipts-disabled, privacy exclusions, applicable-set building. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, seedMessage, deliver, read, countEvents } from "./helpers.js";
import { ReceiptTick, ReceiptEventType } from "../types/types.js";
import { computeTick, buildApplicableSet, resolvePolicy } from "../aggregation/receiptPolicy.js";
import { createAggregate } from "../aggregation/aggregator.js";

describe("computeTick (pure)", () => {
  it("single until all delivered, grey when all delivered, blue when all read", () => {
    const base = createAggregate({ messageId: "m", groupId: "g", applicableMembers: ["a", "b"] });
    assert.equal(computeTick({ ...base, deliveredCount: 1, readCount: 0 }), ReceiptTick.SINGLE);
    assert.equal(computeTick({ ...base, deliveredCount: 2, readCount: 0 }), ReceiptTick.GREY_DOUBLE);
    assert.equal(computeTick({ ...base, deliveredCount: 2, readCount: 1 }), ReceiptTick.GREY_DOUBLE);
    assert.equal(computeTick({ ...base, deliveredCount: 2, readCount: 2 }), ReceiptTick.BLUE_DOUBLE);
  });

  it("no applicable members → single (message exists, reaches no one)", () => {
    const solo = createAggregate({ messageId: "m", groupId: "g", applicableMembers: [] });
    assert.equal(computeTick(solo), ReceiptTick.SINGLE);
  });

  it("read-receipts-disabled caps at grey (blue never shown)", () => {
    const agg = createAggregate({ messageId: "m", groupId: "g", applicableMembers: ["a", "b"], readApplicableCount: 0, policy: { readReceiptsEnabled: false } });
    assert.equal(computeTick({ ...agg, deliveredCount: 2, readCount: 2 }, { readReceiptsEnabled: false }), ReceiptTick.GREY_DOUBLE);
  });
});

describe("buildApplicableSet (pure)", () => {
  it("excludes the sender by default", () => {
    const { applicableMembers, readApplicableCount } = buildApplicableSet({ members: ["alice", "bob", "carol"], senderId: "alice" });
    assert.deepEqual(applicableMembers.sort(), ["bob", "carol"]);
    assert.equal(readApplicableCount, 2);
  });

  it("applies explicit exclusions + read-privacy exclusions", () => {
    const { applicableMembers, readApplicableCount, exclusions } = buildApplicableSet({ members: ["alice", "bob", "carol", "dave"], senderId: "alice", excludeMembers: ["dave"], readExcludedMembers: ["carol"] });
    assert.deepEqual(applicableMembers.sort(), ["bob", "carol"]);
    assert.equal(readApplicableCount, 1, "carol excluded from read counting");
    assert.ok(exclusions.some((e) => e.reason === "sender"));
    assert.ok(exclusions.some((e) => e.reason === "read-receipts-off"));
  });

  it("a privacy hook can exclude a member's reads", () => {
    const { readApplicableCount } = buildApplicableSet({ members: ["a", "b", "c"], senderId: "z", readReceiptHook: (m) => m !== "b" });
    assert.equal(readApplicableCount, 2, "b's reads are not counted");
  });

  it("readReceiptsEnabled:false zeroes read-applicable", () => {
    const { readApplicableCount } = buildApplicableSet({ members: ["a", "b"], senderId: "z", policy: { readReceiptsEnabled: false } });
    assert.equal(readApplicableCount, 0);
  });
});

describe("tick transitions through the manager", () => {
  let ctx, m;
  beforeEach(async () => {
    ctx = makeManager();
    m = await seedMessage(ctx.manager, { members: ["alice", "bob", "carol"] }); // applicable = bob, carol
  });

  it("single → grey → blue as members deliver + read", async () => {
    assert.equal((await ctx.manager.getReceipt(m)).tick, ReceiptTick.SINGLE);
    await deliver(ctx.manager, m, "bob");
    assert.equal((await ctx.manager.getReceipt(m)).tick, ReceiptTick.SINGLE, "1 of 2 delivered");
    await deliver(ctx.manager, m, "carol");
    assert.equal((await ctx.manager.getReceipt(m)).tick, ReceiptTick.GREY_DOUBLE, "all delivered");
    await read(ctx.manager, m, "bob");
    assert.equal((await ctx.manager.getReceipt(m)).tick, ReceiptTick.GREY_DOUBLE, "1 of 2 read");
    await read(ctx.manager, m, "carol");
    assert.equal((await ctx.manager.getReceipt(m)).tick, ReceiptTick.BLUE_DOUBLE, "all read");
    assert.equal(countEvents(ctx.captured, ReceiptEventType.GROUP_FULLY_DELIVERED), 1);
    assert.equal(countEvents(ctx.captured, ReceiptEventType.GROUP_FULLY_READ), 1);
  });

  it("reading a member counts them as delivered too (read implies delivery)", async () => {
    await read(ctx.manager, m, "bob"); // bob never got an explicit delivery report
    const r = await ctx.manager.getReceipt(m);
    assert.equal(r.delivered, 1);
    assert.equal(r.read, 1);
  });

  it("sender is not applicable — tracking the sender is rejected", async () => {
    await assert.rejects(() => deliver(ctx.manager, m, "alice"), /not.*applicable/i);
  });

  it("read-receipts-off group: stays grey after full delivery", async () => {
    const ctx2 = makeManager();
    const m2 = await seedMessage(ctx2.manager, { messageId: "m2", members: ["alice", "bob"], policy: { readReceiptsEnabled: false } });
    await deliver(ctx2.manager, m2, "bob");
    await read(ctx2.manager, m2, "bob");
    assert.equal((await ctx2.manager.getReceipt(m2)).tick, ReceiptTick.GREY_DOUBLE, "blue never shown when read receipts off");
  });
});

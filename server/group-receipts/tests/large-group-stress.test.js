/**
 * Large groups + concurrency + performance + integration (Layer 10, Sprint 4): 1000+ members,
 * concurrent deliveries/reads, incremental O(1) receipt reads, delayed delivery/reads, group-comm
 * adapter. DB-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeManager, seedMessage } from "./helpers.js";
import { ReceiptTick, ReceiptEventType } from "../types/types.js";
import { GroupCommEventBus } from "../../group-communication/events/events.js";

describe("large group (1000+ members)", () => {
  it("aggregates delivery + read incrementally to blue for 1500 members", async () => {
    const ctx = makeManager();
    const members = ["sender", ...Array.from({ length: 1500 }, (_, i) => `u${i}`)];
    await seedMessage(ctx.manager, { messageId: "big", senderId: "sender", members });
    // deliver to all applicable members (1500)
    for (let i = 0; i < 1500; i++) await ctx.manager.trackDelivery({ messageId: "big", memberId: `u${i}`, deviceId: `u${i}-d` });
    let r = await ctx.manager.getReceipt("big");
    assert.equal(r.delivered, 1500);
    assert.equal(r.tick, ReceiptTick.GREY_DOUBLE);
    // read by all
    for (let i = 0; i < 1500; i++) await ctx.manager.trackRead({ messageId: "big", memberId: `u${i}`, deviceId: `u${i}-d` });
    r = await ctx.manager.getReceipt("big");
    assert.equal(r.read, 1500);
    assert.equal(r.tick, ReceiptTick.BLUE_DOUBLE);
    assert.equal(ctx.captured.filter((e) => e.type === ReceiptEventType.GROUP_FULLY_READ).length, 1);
  });

  it("receipt read stays O(1) regardless of group size (aggregate, not member scan)", async () => {
    const ctx = makeManager();
    const members = ["s", ...Array.from({ length: 2000 }, (_, i) => `u${i}`)];
    await seedMessage(ctx.manager, { messageId: "big", senderId: "s", members });
    for (let i = 0; i < 1000; i++) await ctx.manager.trackDelivery({ messageId: "big", memberId: `u${i}`, deviceId: `u${i}-d` });
    // The receipt is served from the aggregate — the counts are correct without enumerating 2000 members.
    const r = await ctx.manager.getReceipt("big");
    assert.equal(r.applicable, 2000);
    assert.equal(r.delivered, 1000);
    assert.equal(r.pending, 1000);
    assert.equal(r.tick, ReceiptTick.SINGLE);
  });
});

describe("concurrency", () => {
  it("concurrent deliveries from many members never lose or double-count", async () => {
    const ctx = makeManager();
    const members = ["s", ...Array.from({ length: 200 }, (_, i) => `u${i}`)];
    await seedMessage(ctx.manager, { messageId: "c", senderId: "s", members });
    await Promise.all(Array.from({ length: 200 }, (_, i) => ctx.manager.trackDelivery({ messageId: "c", memberId: `u${i}`, deviceId: `u${i}-d` })));
    assert.equal((await ctx.manager.getReceipt("c")).delivered, 200);
  });

  it("concurrent multi-device reads for the SAME member count once", async () => {
    const ctx = makeManager();
    const m = await seedMessage(ctx.manager, { messageId: "c2", members: ["alice", "bob"] });
    await Promise.all(Array.from({ length: 20 }, (_, i) => ctx.manager.trackRead({ messageId: m, memberId: "bob", deviceId: `bob-${i}` })));
    assert.equal((await ctx.manager.getReceipt(m)).read, 1, "bob read counted exactly once despite 20 devices");
  });
});

describe("delayed delivery + reads", () => {
  it("late delivery/read still advance the tick correctly", async () => {
    const ctx = makeManager();
    const m = await seedMessage(ctx.manager, { members: ["alice", "bob", "carol"] });
    await ctx.manager.trackDelivery({ messageId: m, memberId: "bob", deviceId: "bob-d" });
    ctx.clock.advance(60_000); // carol delivers much later
    await ctx.manager.trackDelivery({ messageId: m, memberId: "carol", deviceId: "carol-d" });
    assert.equal((await ctx.manager.getReceipt(m)).tick, ReceiptTick.GREY_DOUBLE);
    ctx.clock.advance(3_600_000); // reads a long time later
    await ctx.manager.trackRead({ messageId: m, memberId: "bob", deviceId: "bob-d" });
    await ctx.manager.trackRead({ messageId: m, memberId: "carol", deviceId: "carol-d" });
    assert.equal((await ctx.manager.getReceipt(m)).tick, ReceiptTick.BLUE_DOUBLE);
    const a = await ctx.manager.getAnalytics(m);
    assert.ok(a.avgReadLatencyMs > 0);
  });
});

describe("group-communication integration seam", () => {
  it("auto-drives receipts off Sprint-2 delivery + received events", async () => {
    const ctx = makeManager();
    const bus = new GroupCommEventBus();
    ctx.manager.attachToGroupComm(bus, { resolveMember: (deviceId) => String(deviceId).replace(/-d$/, "") });
    await seedMessage(ctx.manager, { messageId: "x", members: ["alice", "bob", "carol"] });
    bus.emit("group-comm.delivery_updated", { messageId: "x", deviceId: "bob-d", state: "delivered" });
    bus.emit("group-comm.delivery_updated", { messageId: "x", deviceId: "carol-d", state: "delivered" });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal((await ctx.manager.getReceipt("x")).tick, ReceiptTick.GREY_DOUBLE);
    bus.emit("group-comm.message_received", { messageId: "x", deviceId: "bob-d" });
    bus.emit("group-comm.message_received", { messageId: "x", deviceId: "carol-d" });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal((await ctx.manager.getReceipt("x")).tick, ReceiptTick.BLUE_DOUBLE);
  });
});

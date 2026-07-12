/**
 * Per-member delivery + read tracking (Layer 10, Sprint 4): multi-device, duplicate-read prevention,
 * delivery statuses, latency, reader/pending lists, offline members. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeManager, seedMessage, deliver, read, countEvents } from "./helpers.js";
import { ReceiptEventType, DeliveryStatus } from "../types/types.js";
import { createMemberReceipt, applyDelivery, rollUpDeliveryStatus } from "../delivery/deliveryTracker.js";
import { applyRead, readingDevices } from "../reads/readTracker.js";

describe("delivery tracker (pure)", () => {
  it("rolls up the member status to the most-advanced device", () => {
    const devices = { d1: { status: DeliveryStatus.SENT }, d2: { status: DeliveryStatus.DELIVERED } };
    assert.equal(rollUpDeliveryStatus(devices), DeliveryStatus.DELIVERED);
  });

  it("flags first delivery once + computes latency", () => {
    const rec = createMemberReceipt({ messageId: "m", groupId: "g", memberId: "bob", sentAt: new Date(1000).toISOString() });
    const r1 = applyDelivery(rec, { deviceId: "d1", at: new Date(1150).toISOString() });
    assert.equal(r1.memberBecameDelivered, true);
    assert.equal(r1.record.deliveryLatencyMs, 150);
    const r2 = applyDelivery(r1.record, { deviceId: "d2", at: new Date(1300).toISOString() });
    assert.equal(r2.memberBecameDelivered, false, "second device does not re-flag");
  });
});

describe("read tracker (pure)", () => {
  it("dedupes reads across devices + implies delivery", () => {
    const rec = createMemberReceipt({ messageId: "m", groupId: "g", memberId: "bob", sentAt: new Date(1000).toISOString() });
    const r1 = applyRead(rec, { deviceId: "d1", at: new Date(1200).toISOString() });
    assert.equal(r1.memberBecameRead, true);
    assert.equal(r1.memberBecameDelivered, true, "read implies delivery");
    const r2 = applyRead(r1.record, { deviceId: "d2", at: new Date(1500).toISOString() });
    assert.equal(r2.memberBecameRead, false, "second device read does not re-flag");
    assert.equal(readingDevices(r2.record).length, 2, "both devices recorded as reading");
  });
});

describe("multi-device tracking through the manager", () => {
  let ctx, m;
  beforeEach(async () => {
    ctx = makeManager();
    m = await seedMessage(ctx.manager, { members: ["alice", "bob", "carol"] });
  });

  it("counts a member once across multiple devices (delivery + read)", async () => {
    await deliver(ctx.manager, m, "bob", "bob-web");
    await deliver(ctx.manager, m, "bob", "bob-phone");
    await deliver(ctx.manager, m, "bob", "bob-tablet");
    assert.equal((await ctx.manager.getReceipt(m)).delivered, 1, "bob counted once");
    await read(ctx.manager, m, "bob", "bob-web");
    await read(ctx.manager, m, "bob", "bob-phone");
    assert.equal((await ctx.manager.getReceipt(m)).read, 1, "bob read counted once");
    assert.equal(countEvents(ctx.captured, ReceiptEventType.MEMBER_DELIVERED), 1);
    assert.equal(countEvents(ctx.captured, ReceiptEventType.MEMBER_READ), 1);
    const member = await ctx.manager.getMemberReceipt(m, "bob");
    assert.equal(member.devices.length, 3);
  });

  it("tracks delivery statuses + failure without over-counting", async () => {
    await ctx.manager.trackDelivery({ messageId: m, memberId: "bob", deviceId: "bob-web", status: DeliveryStatus.FAILED });
    let r = await ctx.manager.getReceipt(m);
    assert.equal(r.delivered, 0);
    assert.equal(r.failed, 1);
    await ctx.manager.trackDelivery({ messageId: m, memberId: "bob", deviceId: "bob-web", status: DeliveryStatus.DELIVERED }); // retry succeeds
    r = await ctx.manager.getReceipt(m);
    assert.equal(r.delivered, 1);
  });

  it("lists readers + pending members", async () => {
    await deliver(ctx.manager, m, "bob");
    await read(ctx.manager, m, "bob");
    const readers = await ctx.manager.getReaders(m);
    assert.equal(readers.total, 1);
    assert.equal(readers.readers[0].memberId, "bob");
    const pending = await ctx.manager.getPendingMembers(m);
    assert.equal(pending.total, 1, "carol still pending");
    assert.equal(pending.pending[0].memberId, "carol");
  });

  it("offline members via presence resolver", async () => {
    const offlineSet = new Set(["carol"]);
    const ctx2 = makeManager({ presenceResolver: (m) => !offlineSet.has(m) });
    const m2 = await seedMessage(ctx2.manager, { messageId: "m2", members: ["alice", "bob", "carol"] });
    await deliver(ctx2.manager, m2, "bob");
    const offline = await ctx2.manager.getOfflineMembers(m2);
    assert.equal(offline.total, 1);
    assert.equal(offline.offline[0].memberId, "carol");
  });

  it("member receipt exposes per-device delivery + read detail", async () => {
    await deliver(ctx.manager, m, "bob", "bob-web");
    await read(ctx.manager, m, "bob", "bob-web");
    const member = await ctx.manager.getMemberReceipt(m, "bob");
    const web = member.devices.find((d) => d.deviceId === "bob-web");
    assert.equal(web.delivered, true);
    assert.equal(web.read, true);
  });
});

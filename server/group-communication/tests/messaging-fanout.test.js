/**
 * Secure group messaging + fan-out (Layer 10, Sprint 2): send, multi-device fan-out, sender-device skip,
 * online/offline split, delivery status, priorities, partial delivery, duplicate guard. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeEngine, countEvents, deviceId } from "./helpers.js";
import { GroupCommEventType, GroupDeliveryState, FanoutStatus, DeliveryPriority } from "../types/types.js";
import { generateFanoutPlan, recomputeFanoutStatus, validateFanoutPlan } from "../fanout/fanoutPlanner.js";
import { DeliveryGuard } from "../delivery/delivery.js";

describe("fan-out planner (pure)", () => {
  it("builds one leg per device, skips the sender's device, sorts by priority", () => {
    const plan = generateFanoutPlan({
      message: { messageId: "m1", groupId: "g", keyVersion: 1, senderId: "alice", priority: DeliveryPriority.NORMAL },
      recipients: [
        { memberId: "alice", devices: [{ deviceId: "alice-web", online: true }, { deviceId: "alice-phone", online: true }] },
        { memberId: "bob", devices: [{ deviceId: "bob-web", online: false }] },
      ],
      senderDeviceId: "alice-web",
    });
    const ids = plan.legs.map((l) => l.deviceId);
    assert.ok(!ids.includes("alice-web"), "own sending device skipped");
    assert.deepEqual(ids.sort(), ["alice-phone", "bob-web"]);
    assert.equal(plan.onlineCount, 1);
    assert.equal(plan.offlineCount, 1);
    validateFanoutPlan(plan);
  });

  it("caps a plan at maxFanout (partial fan-out) + rejects duplicate devices", () => {
    const recipients = Array.from({ length: 10 }, (_, i) => ({ memberId: `m${i}`, devices: [{ deviceId: `m${i}-d`, online: true }] }));
    const plan = generateFanoutPlan({ message: { messageId: "m", groupId: "g", keyVersion: 1 }, recipients, maxFanout: 4 });
    assert.equal(plan.legs.length, 4);
    assert.ok(plan.truncated);
    assert.throws(() => validateFanoutPlan({ ...plan, planId: "p", legs: [{ deviceId: "x" }, { deviceId: "x" }] }), /duplicate device/i);
  });

  it("recomputes status: all delivered → completed; some queued → partial", () => {
    const base = { planId: "p", groupId: "g", messageId: "m", legs: [{ deviceId: "a", state: GroupDeliveryState.DELIVERED }, { deviceId: "b", state: GroupDeliveryState.QUEUED }] };
    assert.equal(recomputeFanoutStatus(base).status, FanoutStatus.PARTIAL);
    assert.equal(recomputeFanoutStatus({ ...base, legs: [{ deviceId: "a", state: GroupDeliveryState.DELIVERED }] }).status, FanoutStatus.COMPLETED);
  });
});

describe("delivery guard (pure)", () => {
  it("rejects a second delivery of the same (message, device)", () => {
    const g = new DeliveryGuard();
    g.mark("m1", "d1");
    assert.ok(g.has("m1", "d1"));
    assert.throws(() => g.mark("m1", "d1"), /already delivered/i);
    g.mark("m1", "d2"); // different device ok
  });
});

describe("group messaging through the engine", () => {
  let ctx;
  beforeEach(async () => {
    // alice, bob online; carol offline
    ctx = makeEngine({ members: ["alice", "bob", "carol"], online: new Set([deviceId("alice"), deviceId("bob")]) });
    await ctx.api.establishGroupKey({ groupId: "g", actorId: "alice" });
  });

  it("sends an encrypted message, fans out to online members, defers offline", async () => {
    const r = await ctx.api.sendGroupMessage({ groupId: "g", senderId: "alice", senderDeviceId: deviceId("alice"), ciphertext: "ENC(hi)" });
    assert.equal(r.message.keyVersion, 1);
    assert.ok(!("plaintext" in r.message), "engine never has plaintext");
    // bob online → delivered; carol offline → queued; alice's own device skipped
    assert.equal(r.fanout.summary.delivered, 1);
    assert.equal(r.fanout.summary.queued, 1);
    assert.equal(r.fanout.status, FanoutStatus.PARTIAL);
    assert.equal(ctx.sends.length, 1, "one Layer-8 dispatch (bob only)");
    assert.equal(ctx.sends[0].receiverDeviceId, deviceId("bob"));
    assert.equal(ctx.sends[0].encryptedPayload, "ENC(hi)", "opaque ciphertext handed to Layer 8");
    assert.equal(countEvents(ctx.captured, GroupCommEventType.GROUP_MESSAGE_SENT), 1);
    assert.equal(countEvents(ctx.captured, GroupCommEventType.FANOUT_COMPLETED), 1);
    assert.equal(countEvents(ctx.captured, GroupCommEventType.OFFLINE_MEMBER_QUEUED), 1);
  });

  it("delivery status reflects per-leg roll-up + receive advances it", async () => {
    const r = await ctx.api.sendGroupMessage({ groupId: "g", senderId: "alice", senderDeviceId: deviceId("alice"), ciphertext: "ENC(hi)" });
    let status = await ctx.api.getDeliveryStatus({ groupId: "g", messageId: r.message.messageId });
    assert.equal(status.summary.delivered, 1);
    // carol's device confirms receipt later
    await ctx.api.receiveGroupMessage({ groupId: "g", messageId: r.message.messageId, deviceId: deviceId("carol"), memberId: "carol" });
    status = await ctx.api.getDeliveryStatus({ groupId: "g", messageId: r.message.messageId });
    assert.equal(status.summary.delivered, 2);
    assert.equal(countEvents(ctx.captured, GroupCommEventType.GROUP_MESSAGE_RECEIVED), 1);
  });

  it("rejects a send from a non-member + with no ciphertext", async () => {
    await assert.rejects(() => ctx.api.sendGroupMessage({ groupId: "g", senderId: "stranger", senderDeviceId: "x", ciphertext: "ENC" }), /not an active member/i);
    await assert.rejects(() => ctx.api.sendGroupMessage({ groupId: "g", senderId: "alice", senderDeviceId: "x", ciphertext: "" }), /ciphertext/i);
  });

  it("rejects sending before a key is established", async () => {
    const ctx2 = makeEngine({ members: ["a", "b"] });
    await assert.rejects(() => ctx2.api.sendGroupMessage({ groupId: "g2", senderId: "a", senderDeviceId: "a-d", ciphertext: "ENC" }), /No active group key/i);
  });

  it("stamps the message with the active key version + accepts an explicit usable version", async () => {
    await ctx.engine.handleMembershipChange({ groupId: "g", trigger: "member-join", memberId: "dave" }); // v2 active, v1 superseded
    const r = await ctx.api.sendGroupMessage({ groupId: "g", senderId: "alice", senderDeviceId: deviceId("alice"), ciphertext: "ENC(v1)", keyVersion: 1 });
    assert.equal(r.message.keyVersion, 1, "an explicit superseded-but-usable version is honoured");
  });

  it("fan-out diagnostics roll up recent plans", async () => {
    await ctx.api.sendGroupMessage({ groupId: "g", senderId: "alice", senderDeviceId: deviceId("alice"), ciphertext: "ENC(1)" });
    await ctx.api.sendGroupMessage({ groupId: "g", senderId: "alice", senderDeviceId: deviceId("alice"), ciphertext: "ENC(2)" });
    const diag = await ctx.api.fanoutDiagnostics({ groupId: "g" });
    assert.equal(diag.totals.plans, 2);
    assert.equal(diag.totals.delivered, 2);
    assert.equal(diag.totals.queued, 2);
  });
});

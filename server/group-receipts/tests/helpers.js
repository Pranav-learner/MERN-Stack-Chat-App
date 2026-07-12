/**
 * Shared test helpers for the Group Delivery Intelligence (Layer 10, Sprint 4) suite. DB-free —
 * everything runs under `node --test` with an in-memory repository + a deterministic clock, so the tests
 * never import mongoose.
 */

import { GroupReceiptManager } from "../manager/groupReceiptManager.js";
import { createInMemoryReceiptRepository } from "../repository/inMemoryReceiptRepository.js";
import { createReceiptApi } from "../api/receiptApi.js";
import { GroupReceiptEventBus } from "../events/events.js";
import { ReceiptCache } from "../cache/receiptCache.js";

export function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

/** Build a manager + api over an in-memory repo with a captured event log. */
export function makeManager(options = {}) {
  const clock = options.clock ?? makeClock();
  const repo = createInMemoryReceiptRepository();
  const events = new GroupReceiptEventBus();
  const cache = new ReceiptCache({ clock: clock.now, ttlMs: options.cacheTtlMs, distributed: options.distributed });
  const manager = new GroupReceiptManager({
    ...repo,
    events,
    cache,
    clock: clock.now,
    policy: options.policy,
    readReceiptHook: options.readReceiptHook,
    presenceResolver: options.presenceResolver,
  });
  const api = createReceiptApi(manager);
  const captured = [];
  events.on("*", (e) => captured.push(e));
  return { manager, api, repo, events, cache, clock, captured };
}

export function countEvents(list, type) {
  return list.filter((e) => e.type === type).length;
}

/** Register a message + return its id. Sender auto-excluded; applicable = members minus sender. */
export async function seedMessage(manager, { messageId = "m1", groupId = "g", senderId = "alice", members = ["alice", "bob", "carol"], policy, readExcludedMembers } = {}) {
  await manager.registerMessage({ messageId, groupId, senderId, applicableMembers: members, policy, readExcludedMembers });
  return messageId;
}

/** Deliver + read helpers. */
export const deliver = (mgr, messageId, memberId, deviceId = `${memberId}-d`) => mgr.trackDelivery({ messageId, memberId, deviceId });
export const read = (mgr, messageId, memberId, deviceId = `${memberId}-d`) => mgr.trackRead({ messageId, memberId, deviceId });

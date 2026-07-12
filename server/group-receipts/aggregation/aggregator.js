/**
 * @module group-receipts/aggregation
 *
 * The **Receipt Aggregation Engine** — the heart of the subsystem's scalability. It maintains an
 * INCREMENTAL per-message aggregate (counters + latency sums), so a receipt query is **O(1)** and never
 * scans the member set. Each per-member transition (first delivery / first read) applies a small delta
 * to the aggregate; multi-device dedup happens in the trackers, so every counter increments exactly once
 * per member.
 *
 * @security The aggregate holds counts + timestamps + an applicable-member snapshot ONLY — never content
 * or keys. Pure functions — every mutation returns a NEW aggregate (immutable).
 *
 * @performance `createAggregate` is O(applicable) once (snapshotting the member set); every subsequent
 * `applyDeliveryDelta` / `applyReadDelta` is O(1). This is the "aggregation must not scan every member
 * on every query" guarantee.
 */

import { ReceiptTick, GROUP_RECEIPTS_SCHEMA_VERSION } from "../types/types.js";
import { computeTick } from "./receiptPolicy.js";

/**
 * Build a fresh aggregate for a message. @param {object} params
 * @param {string} params.messageId @param {string} params.groupId @param {string} params.senderId
 * @param {string[]} params.applicableMembers @param {number} [params.readApplicableCount]
 * @param {object} [params.policy] @param {string} [params.sentAt]
 * @returns {import("../types/types.js").ReceiptAggregate}
 */
export function createAggregate(params) {
  const nowIso = params.sentAt ?? new Date().toISOString();
  const applicableMembers = [...new Set((params.applicableMembers ?? []).map(String))];
  const aggregate = {
    messageId: String(params.messageId),
    groupId: String(params.groupId),
    senderId: params.senderId != null ? String(params.senderId) : null,
    applicableMembers,
    applicableCount: applicableMembers.length,
    readApplicableCount: params.readApplicableCount ?? applicableMembers.length,
    deliveredCount: 0,
    readCount: 0,
    failedCount: 0,
    deliveryLatencySumMs: 0,
    deliveryLatencyCount: 0,
    readLatencySumMs: 0,
    readLatencyCount: 0,
    fullyDeliveredAt: null,
    fullyReadAt: null,
    tick: ReceiptTick.SINGLE,
    policy: params.policy ?? {},
    sentAt: nowIso,
    version: 1,
    updatedAt: nowIso,
    schemaVersion: GROUP_RECEIPTS_SCHEMA_VERSION,
  };
  aggregate.tick = computeTick(aggregate, aggregate.policy);
  return aggregate;
}

/**
 * Apply a member's FIRST delivery to the aggregate (O(1)). @param {object} aggregate
 * @param {{ latencyMs?: number, at?: string }} [delta]
 * @returns {{ aggregate, fullyDelivered: boolean, tickChanged: boolean }}
 */
export function applyDeliveryDelta(aggregate, delta = {}) {
  const at = delta.at ?? new Date().toISOString();
  const prevTick = aggregate.tick;
  const deliveredCount = Math.min(aggregate.applicableCount, (aggregate.deliveredCount ?? 0) + 1);
  const deliveryLatencySumMs = (aggregate.deliveryLatencySumMs ?? 0) + (Number.isFinite(delta.latencyMs) ? delta.latencyMs : 0);
  const deliveryLatencyCount = (aggregate.deliveryLatencyCount ?? 0) + (Number.isFinite(delta.latencyMs) ? 1 : 0);
  const wasFullyDelivered = (aggregate.deliveredCount ?? 0) >= aggregate.applicableCount && aggregate.applicableCount > 0;
  const nowFullyDelivered = deliveredCount >= aggregate.applicableCount && aggregate.applicableCount > 0;
  const next = {
    ...aggregate,
    deliveredCount,
    deliveryLatencySumMs,
    deliveryLatencyCount,
    fullyDeliveredAt: aggregate.fullyDeliveredAt ?? (nowFullyDelivered ? at : null),
    version: (aggregate.version ?? 1) + 1,
    updatedAt: at,
  };
  next.tick = computeTick(next, next.policy);
  return { aggregate: next, fullyDelivered: nowFullyDelivered && !wasFullyDelivered, tickChanged: next.tick !== prevTick };
}

/**
 * Apply a member's FIRST read to the aggregate (O(1)). A read may also carry the member's first delivery
 * (reading implies delivery). @param {object} aggregate
 * @param {{ becameDelivered?: boolean, deliveryLatencyMs?: number, readLatencyMs?: number, at?: string }} [delta]
 * @returns {{ aggregate, fullyRead: boolean, fullyDelivered: boolean, tickChanged: boolean }}
 */
export function applyReadDelta(aggregate, delta = {}) {
  const at = delta.at ?? new Date().toISOString();
  let agg = aggregate;
  let fullyDelivered = false;
  if (delta.becameDelivered) {
    const r = applyDeliveryDelta(agg, { latencyMs: delta.deliveryLatencyMs, at });
    agg = r.aggregate;
    fullyDelivered = r.fullyDelivered;
  }
  const prevTick = agg.tick;
  const readCount = Math.min(agg.readApplicableCount, (agg.readCount ?? 0) + 1);
  const readLatencySumMs = (agg.readLatencySumMs ?? 0) + (Number.isFinite(delta.readLatencyMs) ? delta.readLatencyMs : 0);
  const readLatencyCount = (agg.readLatencyCount ?? 0) + (Number.isFinite(delta.readLatencyMs) ? 1 : 0);
  const wasFullyRead = (agg.readCount ?? 0) >= agg.readApplicableCount && agg.readApplicableCount > 0;
  const nowFullyRead = readCount >= agg.readApplicableCount && agg.readApplicableCount > 0;
  const next = {
    ...agg,
    readCount,
    readLatencySumMs,
    readLatencyCount,
    fullyReadAt: agg.fullyReadAt ?? (nowFullyRead ? at : null),
    version: (agg.version ?? 1) + 1,
    updatedAt: at,
  };
  next.tick = computeTick(next, next.policy);
  return { aggregate: next, fullyRead: nowFullyRead && !wasFullyRead, fullyDelivered, tickChanged: next.tick !== prevTick };
}

/** Apply a member delivery FAILURE to the aggregate (O(1)) — bumps the failed counter. */
export function applyFailureDelta(aggregate, delta = {}) {
  const at = delta.at ?? new Date().toISOString();
  return { ...aggregate, failedCount: (aggregate.failedCount ?? 0) + 1, version: (aggregate.version ?? 1) + 1, updatedAt: at };
}

/** The live counts view (O(1)). */
export function aggregateCounts(aggregate) {
  const applicable = aggregate.applicableCount ?? 0;
  const delivered = aggregate.deliveredCount ?? 0;
  const read = aggregate.readCount ?? 0;
  return {
    applicable,
    delivered,
    read,
    pending: Math.max(0, applicable - delivered),
    waiting: Math.max(0, applicable - delivered), // members not yet delivered = "waiting"
    unread: Math.max(0, (aggregate.readApplicableCount ?? applicable) - read),
    failed: aggregate.failedCount ?? 0,
  };
}

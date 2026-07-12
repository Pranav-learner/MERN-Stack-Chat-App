/**
 * @module group-receipts/serializers
 *
 * Public DTOs for the Group Delivery Intelligence subsystem. Whitelists PUBLIC fields for the receipt
 * view (tick + counts), member receipts, reader lists, and analytics. Every view carries ids + states +
 * counts + ticks ONLY — never content or keys.
 */

import { aggregateCounts } from "../aggregation/aggregator.js";
import { readingDevices } from "../reads/readTracker.js";

/** The headline receipt DTO the UI renders (tick + counts) — O(1). */
export function toReceiptView(aggregate) {
  if (!aggregate) return null;
  const counts = aggregateCounts(aggregate);
  return {
    messageId: aggregate.messageId,
    groupId: aggregate.groupId,
    tick: aggregate.tick,
    delivered: counts.delivered,
    read: counts.read,
    pending: counts.pending,
    applicable: counts.applicable,
    failed: counts.failed,
    fullyDelivered: !!aggregate.fullyDeliveredAt,
    fullyRead: !!aggregate.fullyReadAt,
    fullyDeliveredAt: aggregate.fullyDeliveredAt ?? null,
    fullyReadAt: aggregate.fullyReadAt ?? null,
    updatedAt: aggregate.updatedAt,
  };
}

/** A per-member receipt DTO. */
export function toMemberReceiptView(record) {
  if (!record) return null;
  return {
    messageId: record.messageId,
    memberId: record.memberId,
    deliveryStatus: record.deliveryStatus,
    delivered: !!record.memberDelivered,
    read: !!record.memberRead,
    firstDeliveredAt: record.firstDeliveredAt ?? null,
    firstReadAt: record.firstReadAt ?? null,
    deliveryLatencyMs: record.deliveryLatencyMs ?? null,
    readLatencyMs: record.readLatencyMs ?? null,
    devices: Object.entries(record.devices ?? {}).map(([deviceId, d]) => ({ deviceId, status: d.status, delivered: d.status === "delivered", read: !!d.read, deliveredAt: d.deliveredAt ?? null, readAt: d.readAt ?? null })),
    updatedAt: record.updatedAt,
  };
}

/** A reader-list entry (member + when + which devices). */
export function toReaderView(record) {
  return { memberId: record.memberId, readAt: record.firstReadAt, devices: readingDevices(record) };
}

/** A pending/waiting member entry. */
export function toPendingView(memberId, record) {
  return { memberId, deliveryStatus: record?.deliveryStatus ?? "pending", delivered: !!record?.memberDelivered, sentDevices: record ? Object.keys(record.devices ?? {}).length : 0 };
}

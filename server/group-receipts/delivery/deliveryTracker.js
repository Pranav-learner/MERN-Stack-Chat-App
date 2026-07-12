/**
 * @module group-receipts/delivery
 *
 * **Per-member delivery tracking.** Pure helpers for the per-(message, member) delivery record. A member
 * may have SEVERAL devices; the member-level `deliveryStatus` is the MAX across their devices (a member
 * counts as delivered as soon as ANY of their devices confirms delivery). This module owns the record
 * shape + the pure transitions; the manager coordinates persistence + incremental aggregation.
 *
 * @security Records hold ids + statuses + timestamps + non-secret device metadata ONLY — never content
 * or keys. Pure functions, no I/O — every mutation returns a NEW record (immutable).
 */

import { DeliveryStatus, DELIVERY_RANK, MAX_MEMBER_HISTORY, GROUP_RECEIPTS_SCHEMA_VERSION } from "../types/types.js";

/** The member-level status is the most-advanced device status. */
export function rollUpDeliveryStatus(devices = {}) {
  let best = DeliveryStatus.PENDING;
  for (const d of Object.values(devices)) {
    if ((DELIVERY_RANK[d.status] ?? 0) > (DELIVERY_RANK[best] ?? 0)) best = d.status;
  }
  return best;
}

/**
 * Build an initial member-receipt record (delivery + read state combined). @param {object} params
 * @param {string} params.messageId @param {string} params.groupId @param {string} params.memberId
 * @param {string} params.sentAt
 */
export function createMemberReceipt(params) {
  const nowIso = params.at ?? new Date().toISOString();
  return {
    messageId: String(params.messageId),
    groupId: String(params.groupId),
    memberId: String(params.memberId),
    deliveryStatus: DeliveryStatus.PENDING,
    memberDelivered: false,
    memberRead: false,
    devices: {},
    firstDeliveredAt: null,
    firstReadAt: null,
    sentAt: params.sentAt ?? nowIso,
    deliveryLatencyMs: null,
    readLatencyMs: null,
    history: [],
    version: 1,
    updatedAt: nowIso,
    schemaVersion: GROUP_RECEIPTS_SCHEMA_VERSION,
  };
}

function pushHistory(record, entry) {
  const history = [...(record.history ?? []), entry];
  return history.length > MAX_MEMBER_HISTORY ? history.slice(history.length - MAX_MEMBER_HISTORY) : history;
}

/**
 * Apply a per-DEVICE delivery report. Returns `{ record, memberBecameDelivered }` — the flag is TRUE
 * only on the member's FIRST delivery (so the aggregate counter increments exactly once per member).
 * Pure. @param {object} record @param {{ deviceId, status?, at?, deviceMeta? }} report
 */
export function applyDelivery(record, report) {
  const at = report.at ?? new Date().toISOString();
  const deviceId = String(report.deviceId);
  const status = report.status ?? DeliveryStatus.DELIVERED;
  const prevDevice = record.devices[deviceId] ?? { status: DeliveryStatus.PENDING, read: false, retries: 0 };
  const wasDelivered = record.memberDelivered;

  const device = {
    ...prevDevice,
    status: (DELIVERY_RANK[status] ?? 0) >= (DELIVERY_RANK[prevDevice.status] ?? 0) ? status : prevDevice.status,
    deliveredAt: status === DeliveryStatus.DELIVERED ? (prevDevice.deliveredAt ?? at) : prevDevice.deliveredAt ?? null,
    retries: status === DeliveryStatus.FAILED ? (prevDevice.retries ?? 0) + 1 : prevDevice.retries ?? 0,
    meta: report.deviceMeta ?? prevDevice.meta ?? null,
  };
  const devices = { ...record.devices, [deviceId]: device };
  const memberDelivered = wasDelivered || Object.values(devices).some((d) => d.status === DeliveryStatus.DELIVERED);
  const memberBecameDelivered = memberDelivered && !wasDelivered;

  const firstDeliveredAt = record.firstDeliveredAt ?? (memberDelivered ? at : null);
  const deliveryLatencyMs = memberBecameDelivered ? Math.max(0, new Date(firstDeliveredAt).getTime() - new Date(record.sentAt).getTime()) : record.deliveryLatencyMs;

  return {
    record: {
      ...record,
      devices,
      deliveryStatus: rollUpDeliveryStatus(devices),
      memberDelivered,
      firstDeliveredAt,
      deliveryLatencyMs,
      history: pushHistory(record, { event: "delivery", deviceId, status: device.status, at }),
      version: (record.version ?? 1) + 1,
      updatedAt: at,
    },
    memberBecameDelivered,
  };
}

/** Whether a member has been delivered to (any device). */
export function isMemberDelivered(record) {
  return !!record?.memberDelivered;
}

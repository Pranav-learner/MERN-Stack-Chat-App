/**
 * @module group-receipts/reads
 *
 * **Per-member read tracking.** Pure helpers for the read side of a member-receipt record. The key
 * invariant: **a user counts as READ exactly once, even if several of their devices report a read**
 * (duplicate-read prevention). Reading implies delivery, so a read on a not-yet-delivered member also
 * marks the member delivered. Privacy-policy hooks decide whether a member's reads are tracked at all.
 *
 * @security Records hold ids + read flags + timestamps ONLY — never content or keys. Pure functions —
 * every mutation returns a NEW record (immutable).
 */

import { DeliveryStatus, MAX_MEMBER_HISTORY } from "../types/types.js";

function pushHistory(record, entry) {
  const history = [...(record.history ?? []), entry];
  return history.length > MAX_MEMBER_HISTORY ? history.slice(history.length - MAX_MEMBER_HISTORY) : history;
}

/**
 * Apply a per-DEVICE read report. Returns `{ record, memberBecameRead, memberBecameDelivered }` — the
 * flags are TRUE only on the member's FIRST read / first delivery (so aggregate counters increment
 * exactly once per member). A duplicate read from another device flips no counter. Pure.
 * @param {object} record @param {{ deviceId, at? }} report
 */
export function applyRead(record, report) {
  const at = report.at ?? new Date().toISOString();
  const deviceId = String(report.deviceId);
  const wasRead = record.memberRead;
  const wasDelivered = record.memberDelivered;

  // Reading implies delivery on that device.
  const prevDevice = record.devices[deviceId] ?? { status: DeliveryStatus.PENDING, read: false, retries: 0 };
  const device = {
    ...prevDevice,
    status: DeliveryStatus.DELIVERED,
    deliveredAt: prevDevice.deliveredAt ?? at,
    read: true,
    readAt: prevDevice.readAt ?? at,
  };
  const devices = { ...record.devices, [deviceId]: device };

  const memberRead = true;
  const memberBecameRead = !wasRead;
  const memberDelivered = true;
  const memberBecameDelivered = !wasDelivered;

  const firstDeliveredAt = record.firstDeliveredAt ?? at;
  const firstReadAt = record.firstReadAt ?? at;
  const deliveryLatencyMs = memberBecameDelivered ? Math.max(0, new Date(firstDeliveredAt).getTime() - new Date(record.sentAt).getTime()) : record.deliveryLatencyMs;
  const readLatencyMs = memberBecameRead ? Math.max(0, new Date(firstReadAt).getTime() - new Date(firstDeliveredAt).getTime()) : record.readLatencyMs;

  return {
    record: {
      ...record,
      devices,
      deliveryStatus: DeliveryStatus.DELIVERED,
      memberDelivered,
      memberRead,
      firstDeliveredAt,
      firstReadAt,
      deliveryLatencyMs,
      readLatencyMs,
      history: pushHistory(record, { event: "read", deviceId, at }),
      version: (record.version ?? 1) + 1,
      updatedAt: at,
    },
    memberBecameRead,
    memberBecameDelivered,
  };
}

/** The devices that reported a read (for the "reading devices" view). */
export function readingDevices(record) {
  return Object.entries(record?.devices ?? {}).filter(([, d]) => d.read).map(([deviceId, d]) => ({ deviceId, readAt: d.readAt }));
}

/** Whether a member has read the message (any device). */
export function isMemberRead(record) {
  return !!record?.memberRead;
}

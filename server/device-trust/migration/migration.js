/**
 * @module device-trust/migration
 *
 * Migration & backward-compatibility helpers for the Sprint 2 device-trust fields.
 *
 * ## No destructive migration
 * Sprint 2 only ADDS optional fields to the existing `Device` schema (trustStatus,
 * os, appVersion, capabilities, revokedAt, …). MongoDB is schemaless, so existing
 * device documents are valid as-is; the schema defaults apply on read/write.
 *
 * ## Backfill
 * Sprint 1 devices have no explicit `trustStatus`. This helper derives one from
 * the legacy `status` field so old devices participate in the trust model:
 * `status: "active" → trusted`, `status: "revoked" → revoked`.
 */

import { TrustStatus } from "../types.js";

/**
 * Backfill `trustStatus` for devices that predate Sprint 2. Idempotent.
 *
 * @param {object} devices device repository
 * @param {() => Promise<object[]>} listAll a function returning all device records
 *   (e.g. `() => DeviceModel.find().lean()`); kept injectable so this runs against
 *   any backend without importing Mongoose here.
 * @returns {Promise<{ scanned: number, updated: number }>}
 * @example
 * await backfillTrustStatus(devices, () => Device.find().lean());
 */
export async function backfillTrustStatus(devices, listAll) {
  const all = await listAll();
  let updated = 0;
  for (const device of all) {
    if (device.trustStatus) continue; // already has a trust status
    const trustStatus = device.status === "revoked" ? TrustStatus.REVOKED : TrustStatus.TRUSTED;
    await devices.update(device.deviceId, { trustStatus });
    updated += 1;
  }
  return { scanned: all.length, updated };
}

/**
 * Report the distribution of trust statuses across a user's devices.
 * @param {object} devices device repository
 * @param {string} userId
 * @returns {Promise<Record<string, number>>}
 */
export async function trustStatusBreakdown(devices, userId) {
  const all = await devices.findByUser(userId);
  const breakdown = {};
  for (const d of all) {
    const s = d.trustStatus ?? "unknown";
    breakdown[s] = (breakdown[s] ?? 0) + 1;
  }
  return breakdown;
}

/** Current device-trust schema version (for future forward-migrations). */
export const DEVICE_TRUST_SCHEMA_VERSION = 1;

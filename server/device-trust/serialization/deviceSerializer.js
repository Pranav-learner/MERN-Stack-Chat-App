/**
 * @module device-trust/serialization
 *
 * Public device DTOs for API responses. Whitelists public fields only (there is
 * no private material stored on a device record) and enriches the response with
 * fingerprint display formats and the *effective* trust status (applying expiry).
 */

import { fingerprintFormats } from "../../identity/fingerprints/fingerprint.js";
import { effectiveStatus } from "../policies/trustPolicy.js";

/**
 * @typedef {object} PublicTrustedDeviceDTO
 * @property {string} deviceId
 * @property {string} identityId
 * @property {string} userId
 * @property {string} [name]
 * @property {string} [platform]
 * @property {string} [os]
 * @property {string} [appVersion]
 * @property {string} publicKey
 * @property {string} algorithm
 * @property {{ machine: string, human: string, numeric: string }} fingerprint
 * @property {string} trustStatus stored trust status
 * @property {string} effectiveTrustStatus trust status after applying inactivity expiry
 * @property {boolean} isTrusted convenience flag (effective === trusted)
 * @property {string[]} capabilities
 * @property {object} metadata
 * @property {string} lastActive ISO
 * @property {string} [revokedAt] ISO
 * @property {string} [revokedReason]
 * @property {string} registeredAt ISO
 * @property {string} updatedAt ISO
 */

/**
 * Shape a device record into its public DTO.
 * @param {object} record
 * @param {{ now?: number, inactivityMs?: number }} [options]
 * @returns {PublicTrustedDeviceDTO}
 */
export function toPublicDevice(record, options = {}) {
  const effective = effectiveStatus(record, options);
  return {
    deviceId: record.deviceId,
    identityId: record.identityId,
    userId: String(record.user),
    name: record.name,
    platform: record.platform,
    os: record.os,
    appVersion: record.appVersion,
    publicKey: record.publicKey,
    algorithm: record.algorithm,
    fingerprint: fingerprintFormats(record.fingerprint),
    trustStatus: record.trustStatus,
    effectiveTrustStatus: effective,
    isTrusted: effective === "trusted",
    capabilities: record.capabilities ?? [],
    metadata: record.metadata ?? {},
    lastActive: toIso(record.lastActive),
    revokedAt: toIso(record.revokedAt),
    revokedReason: record.revokedReason,
    registeredAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

/** Shape a list of device records. */
export function toPublicDeviceList(records, options = {}) {
  return records.map((r) => toPublicDevice(r, options));
}

function toIso(value) {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

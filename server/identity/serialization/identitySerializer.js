/**
 * @module identity/serialization
 *
 * Converts internal identity/device records into **public** DTOs for API
 * responses. This is the enforcement point for the invariant: *no private key
 * material ever leaves the server* (the server never stores any, and these DTOs
 * whitelist only public fields).
 */

import { fingerprintFormats } from "../fingerprints/fingerprint.js";

/**
 * @typedef {object} PublicIdentityDTO
 * @property {string} identityId
 * @property {string} userId
 * @property {string} publicKey base64 raw public key
 * @property {string} algorithm
 * @property {{ machine: string, human: string, numeric: string }} fingerprint
 * @property {number} version
 * @property {string} status
 * @property {object} metadata
 * @property {string} createdAt ISO
 * @property {string} updatedAt ISO
 */

/**
 * Shape an identity record into its public DTO (private material excluded).
 * @param {object} record internal identity record
 * @returns {PublicIdentityDTO}
 */
export function toPublicIdentity(record) {
  return {
    identityId: record.identityId,
    userId: String(record.user),
    publicKey: record.publicKey,
    algorithm: record.algorithm,
    fingerprint: fingerprintFormats(record.fingerprint),
    version: record.version,
    status: record.status,
    metadata: record.metadata ?? {},
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

/**
 * @typedef {object} PublicDeviceDTO
 * @property {string} deviceId
 * @property {string} identityId
 * @property {string} userId
 * @property {string} [name]
 * @property {string} [platform]
 * @property {string} publicKey
 * @property {string} algorithm
 * @property {{ machine: string, human: string, numeric: string }} fingerprint
 * @property {string} status
 * @property {string} lastActive ISO
 * @property {string} registeredAt ISO
 */

/**
 * Shape a device record into its public DTO (private material excluded).
 * @param {object} record internal device record
 * @returns {PublicDeviceDTO}
 */
export function toPublicDevice(record) {
  return {
    deviceId: record.deviceId,
    identityId: record.identityId,
    userId: String(record.user),
    name: record.name,
    platform: record.platform,
    publicKey: record.publicKey,
    algorithm: record.algorithm,
    fingerprint: fingerprintFormats(record.fingerprint),
    status: record.status,
    lastActive: toIso(record.lastActive),
    registeredAt: toIso(record.createdAt),
  };
}

/**
 * Minimal public-key DTO for key distribution (future E2EE consumers).
 * @param {object} record identity record
 * @returns {{ userId: string, publicKey: string, algorithm: string, fingerprint: object }}
 */
export function toPublicKeyBundle(record) {
  return {
    userId: String(record.user),
    publicKey: record.publicKey,
    algorithm: record.algorithm,
    fingerprint: fingerprintFormats(record.fingerprint),
  };
}

function toIso(value) {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

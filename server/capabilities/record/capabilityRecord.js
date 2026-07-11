/**
 * @module capabilities/record
 *
 * The **Capability Set** record factory + pure helpers. Every device has one capability set
 * (keyed by `userId + deviceId`), so a user with several devices advertises several capability
 * sets. A record wraps the normalized {@link module:capabilities/advertisement advertisement}
 * fields with a stable id, a lifecycle state, a version counter + history, and a TTL.
 *
 * @security A capability record is a PUBLIC control-plane record — versions, transports, flags,
 * limits. It never carries a private key, session key, message key, chain key, or shared secret,
 * and it never advertises a way to *reach* the device (that is a later layer).
 */

import crypto from "node:crypto";
import {
  CapabilityState,
  CAPABILITY_SCHEMA_VERSION,
  DEFAULT_CAPABILITY_TTL_MS,
  DEFAULT_VERSION_HISTORY_LIMIT,
} from "../types/types.js";
import { createCapabilityAdvertisement } from "../advertisement/advertisement.js";

/**
 * A stable capability key for a device: same user + device → same key. One capability set per
 * device; the repository enforces uniqueness on this pairing.
 * @param {string} userId @param {string} deviceId @returns {string}
 */
export function capabilityKey(userId, deviceId) {
  return `${userId}|${deviceId}`;
}

/**
 * Build a fresh capability set (in the `REGISTERED` state) from raw capability input.
 *
 * @param {object} params
 * @param {string} params.userId @param {string} params.deviceId @param {string} [params.identityId]
 * @param {number} [params.ttlMs] capability TTL → expiration window
 * @param {string} [params.capabilityId] override id (else generated)
 * @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 * @param {...*} params.* — any capability-advertisement fields (protocolVersions, transports, …)
 * @returns {import("../types/types.js").CapabilitySet}
 */
export function createCapabilityRecord(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowMs = clock();
  const nowIso = new Date(nowMs).toISOString();
  const ttlMs = params.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS;
  const advertisement = createCapabilityAdvertisement(params);

  return {
    capabilityId: params.capabilityId ?? idGenerator(),
    userId: String(params.userId),
    identityId: params.identityId != null ? String(params.identityId) : null,
    deviceId: String(params.deviceId),
    ...advertisement,
    state: CapabilityState.REGISTERED,
    version: 1,
    registeredAt: nowIso,
    updatedAt: nowIso,
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    versionHistory: [{ version: 1, at: nowIso, reason: "registered" }],
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
  };
}

/**
 * Append a version-history entry immutably (returns a new array; caps length).
 * @param {object[]} history @param {object} entry @param {number} [max]
 * @returns {object[]}
 */
export function appendVersionHistory(history, entry, max = DEFAULT_VERSION_HISTORY_LIMIT) {
  const next = [...(history ?? []), entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Whether a capability set has passed its TTL.
 * @param {import("../types/types.js").CapabilitySet} record @param {number} [now] epoch ms
 * @returns {boolean}
 */
export function isCapabilityExpired(record, now = Date.now()) {
  if (!record?.expiresAt) return false;
  return new Date(record.expiresAt).getTime() <= now;
}

/**
 * Extract just the negotiable fields from a capability record (what the negotiation engine reads).
 * @param {import("../types/types.js").CapabilitySet} record @returns {object}
 */
export function toNegotiable(record) {
  return {
    capabilityId: record.capabilityId,
    userId: record.userId,
    deviceId: record.deviceId,
    version: record.version,
    protocolVersions: record.protocolVersions ?? [],
    cryptoVersions: record.cryptoVersions ?? [],
    transports: record.transports ?? [],
    compression: record.compression ?? [],
    attachments: record.attachments ?? { supported: false, maxSize: 0 },
    maxPayloadSize: record.maxPayloadSize ?? 0,
    relaySupport: record.relaySupport ?? false,
    connectionPreferences: record.connectionPreferences ?? [],
    featureFlags: record.featureFlags ?? {},
  };
}

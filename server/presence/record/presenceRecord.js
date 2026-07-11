/**
 * @module presence/record
 *
 * The **Presence Record** model — the record factory + pure helpers for one device's presence.
 * Every registered device has exactly one presence record (keyed by `userId + deviceId`), so a
 * user with several devices has several records: this is what makes presence **multi-device**.
 * A record binds a device to a live status, a heartbeat clock, an expiration, a PUBLIC device
 * advertisement, and an append-only status history.
 *
 * @security A presence record is a PUBLIC control-plane record. Its `advertisement` holds a
 * PUBLIC device identity descriptor — never a private key, session key, message key, chain
 * key, or shared secret. No transport reachability is stored (that is a future sprint).
 */

import crypto from "node:crypto";
import {
  PresenceStatus,
  PRESENCE_SCHEMA_VERSION,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_STATUS_HISTORY_LIMIT,
} from "../types/types.js";
import { createDeviceAdvertisement } from "../advertisement/advertisement.js";

/**
 * A stable presence key for a device: same user + device → same key. One presence record per
 * device; the repository enforces uniqueness on this pairing.
 * @param {string} userId @param {string} deviceId @returns {string}
 */
export function presenceKey(userId, deviceId) {
  return `${userId}|${deviceId}`;
}

/**
 * Build a fresh presence record in the requested (default `ONLINE`) status.
 *
 * @param {object} params
 * @param {string} params.userId @param {string} params.deviceId
 * @param {string} [params.identityId]
 * @param {object|null} [params.identity] raw PUBLIC identity record (→ advertisement.publicIdentity)
 * @param {string} [params.status] initial status (default `ONLINE`)
 * @param {string} [params.softwareVersion] @param {string} [params.platform]
 * @param {number} [params.timeoutMs] heartbeat timeout → expiration window
 * @param {object} [params.metadata] free-form PUBLIC metadata
 * @param {string} [params.presenceId] override id (else generated)
 * @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 * @returns {import("../types/types.js").PresenceRecord}
 */
export function createPresenceRecord(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowMs = clock();
  const nowIso = new Date(nowMs).toISOString();
  const timeoutMs = params.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const status = params.status ?? PresenceStatus.ONLINE;
  const identityId = params.identityId != null ? String(params.identityId) : params.identity?.identityId ?? null;

  const advertisement = createDeviceAdvertisement({
    userId: params.userId,
    deviceId: params.deviceId,
    identityId,
    identity: params.identity ?? null,
    status,
    softwareVersion: params.softwareVersion,
    platform: params.platform,
    at: nowIso,
    metadata: params.metadata,
  });

  return {
    presenceId: params.presenceId ?? idGenerator(),
    userId: String(params.userId),
    identityId,
    deviceId: String(params.deviceId),
    status,
    registeredAt: nowIso,
    lastSeen: nowIso,
    heartbeatAt: nowIso,
    expiresAt: new Date(nowMs + timeoutMs).toISOString(),
    advertisement,
    version: 1,
    statusHistory: [{ from: null, to: status, at: nowIso, reason: "registered" }],
    missedHeartbeats: 0,
    metadata: params.metadata ?? {},
    schemaVersion: PRESENCE_SCHEMA_VERSION,
  };
}

/**
 * Append a status-history entry immutably (returns a new array; caps length).
 * @param {object[]} history @param {object} entry @param {number} [max]
 * @returns {object[]}
 */
export function appendStatusHistory(history, entry, max = DEFAULT_STATUS_HISTORY_LIMIT) {
  const next = [...(history ?? []), entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Whether a presence record has passed its heartbeat expiration instant.
 * @param {import("../types/types.js").PresenceRecord} record @param {number} [now] epoch ms
 * @returns {boolean}
 */
export function isPresenceExpired(record, now = Date.now()) {
  if (!record?.expiresAt) return false;
  return new Date(record.expiresAt).getTime() <= now;
}

/** Milliseconds until a record expires (negative if already expired). @returns {number} */
export function msUntilExpiry(record, now = Date.now()) {
  if (!record?.expiresAt) return Infinity;
  return new Date(record.expiresAt).getTime() - now;
}

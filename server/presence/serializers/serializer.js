/**
 * @module presence/serializers
 *
 * Public DTOs for the Presence Service. This is the API/network guardrail: it whitelists
 * PUBLIC fields for a presence record, a device advertisement, and compact status/last-seen
 * views. Presence records never contain secret material, but this layer also defensively
 * omits anything it does not explicitly whitelist.
 *
 * @security The advertisement DTO exposes a PUBLIC identity key + fingerprint only. The
 * connection/transport placeholders are surfaced (so future-sprint consumers can detect the
 * framework is present) but are inert.
 */

import { isReachableStatus, isVisibleOnlineStatus } from "../types/types.js";

/**
 * Shape a device advertisement into its public DTO (whitelist).
 * @param {import("../types/types.js").DeviceAdvertisement} a @returns {object|null}
 */
export function toPublicAdvertisement(a) {
  if (!a) return null;
  return {
    userId: a.userId,
    identityId: a.identityId ?? null,
    deviceId: a.deviceId,
    publicIdentity: a.publicIdentity ? { ...a.publicIdentity } : null,
    status: a.status,
    softwareVersion: a.softwareVersion,
    platform: a.platform,
    // FUTURE placeholders — surfaced but inert.
    connection: { ...(a.connection ?? {}) },
    transport: { ...(a.transport ?? {}) },
    version: a.version,
    advertisedAt: a.advertisedAt,
    metadata: a.metadata ?? {},
    schemaVersion: a.schemaVersion,
  };
}

/**
 * Shape a presence record into its public DTO.
 * @param {import("../types/types.js").PresenceRecord} r
 * @param {{ includeHistory?: boolean }} [context] @returns {object|null}
 */
export function toPublicPresence(r, context = {}) {
  if (!r) return null;
  const dto = {
    presenceId: r.presenceId,
    userId: r.userId,
    identityId: r.identityId ?? null,
    deviceId: r.deviceId,
    status: r.status,
    reachable: isReachableStatus(r.status),
    online: isVisibleOnlineStatus(r.status),
    registeredAt: r.registeredAt,
    lastSeen: r.lastSeen,
    heartbeatAt: r.heartbeatAt,
    expiresAt: r.expiresAt,
    advertisement: toPublicAdvertisement(r.advertisement),
    version: r.version,
    missedHeartbeats: r.missedHeartbeats ?? 0,
    metadata: r.metadata ?? {},
    schemaVersion: r.schemaVersion,
  };
  if (context.includeHistory) dto.statusHistory = (r.statusHistory ?? []).map((h) => ({ ...h }));
  return dto;
}

/**
 * A compact status view — just enough for a client to poll a device's presence.
 * @param {import("../types/types.js").PresenceRecord} r @returns {object}
 */
export function toPresenceStatus(r) {
  return {
    presenceId: r.presenceId,
    userId: r.userId,
    deviceId: r.deviceId,
    status: r.status,
    reachable: isReachableStatus(r.status),
    online: isVisibleOnlineStatus(r.status),
    lastSeen: r.lastSeen,
    heartbeatAt: r.heartbeatAt,
    expiresAt: r.expiresAt,
  };
}

/**
 * A last-seen view for a device (for "when was this device last around?").
 * @param {import("../types/types.js").PresenceRecord} r @returns {object}
 */
export function toLastSeen(r) {
  return {
    userId: r.userId,
    deviceId: r.deviceId,
    status: r.status,
    reachable: isReachableStatus(r.status),
    lastSeen: r.lastSeen,
  };
}

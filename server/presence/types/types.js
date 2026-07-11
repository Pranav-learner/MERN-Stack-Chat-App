/**
 * @module presence/types
 *
 * Enums and type declarations for the **Presence & Device Advertisement Service** — Layer 6,
 * Sprint 2. Presence answers a single question: *"Which authenticated devices are currently
 * reachable?"* It maintains a real-time, per-device availability record driven by heartbeats,
 * and publishes a PUBLIC device advertisement for each reachable device.
 *
 * @security This sprint exposes ONLY public presence + advertisement metadata — user ids,
 * identity ids, device ids, presence status, timestamps, software version, platform, and the
 * device's PUBLIC identity key + fingerprint. It NEVER exposes private keys, session keys,
 * message keys, chain keys, or shared secrets. See {@link module:presence/validators} for the
 * enforced no-secret invariant.
 *
 * @evolution Presence is transport-INDEPENDENT. It reports *whether* a device is reachable,
 * NOT *how* to reach it. Future Layer 6 sprints (Capability Exchange, then NAT Traversal /
 * ICE / STUN / TURN / WebRTC) consume this service and populate the inert connection/transport
 * placeholders on every advertisement. Presence never negotiates a transport or opens a
 * connection.
 */

/**
 * A device's presence status. The lifecycle is a validated finite state machine over these
 * (see {@link module:presence/lifecycle}).
 *
 * - `ONLINE`       — connected + reachable + visible.
 * - `AWAY`         — reachable, user idle.
 * - `BUSY`         — reachable, user busy / do-not-disturb.
 * - `INVISIBLE`    — reachable but chooses to appear offline (hidden from the public online list).
 * - `RECONNECTING` — transiently dropped; a client is actively trying to restore the session.
 * - `DISCONNECTED` — the connection was lost (unclean); not reachable, awaiting reconnect/expiry.
 * - `OFFLINE`      — a clean sign-off; not reachable.
 * - `EXPIRED`      — heartbeats stopped past the timeout; swept to not-reachable.
 * - `UNKNOWN`      — indeterminate (initial / never-registered).
 * @readonly @enum {string}
 */
export const PresenceStatus = Object.freeze({
  ONLINE: "online",
  AWAY: "away",
  BUSY: "busy",
  INVISIBLE: "invisible",
  RECONNECTING: "reconnecting",
  DISCONNECTED: "disconnected",
  OFFLINE: "offline",
  EXPIRED: "expired",
  UNKNOWN: "unknown",
});

/** All presence statuses, canonical order. */
export const ALL_PRESENCE_STATUSES = Object.freeze(Object.values(PresenceStatus));

/**
 * States in which a device is CONNECTED and can receive — i.e. genuinely reachable. Note
 * `INVISIBLE` is reachable (the device is connected) even though it is hidden from the public
 * online list. This is the set {@link module:presence/manager.resolveActiveDevices} returns.
 */
export const REACHABLE_PRESENCE_STATUSES = Object.freeze([
  PresenceStatus.ONLINE,
  PresenceStatus.AWAY,
  PresenceStatus.BUSY,
  PresenceStatus.INVISIBLE,
]);

/**
 * States that appear in the PUBLIC "online" list. `INVISIBLE` is deliberately excluded — the
 * device is reachable but the user chose to appear offline.
 */
export const VISIBLE_ONLINE_STATUSES = Object.freeze([
  PresenceStatus.ONLINE,
  PresenceStatus.AWAY,
  PresenceStatus.BUSY,
]);

/** States representing "not currently reachable" (offline-ish / resting / transitional). */
export const UNREACHABLE_PRESENCE_STATUSES = Object.freeze([
  PresenceStatus.RECONNECTING,
  PresenceStatus.DISCONNECTED,
  PresenceStatus.OFFLINE,
  PresenceStatus.EXPIRED,
  PresenceStatus.UNKNOWN,
]);

/** Statuses a user may explicitly SET (the others are system/heartbeat-driven). */
export const USER_SETTABLE_STATUSES = Object.freeze([
  PresenceStatus.ONLINE,
  PresenceStatus.AWAY,
  PresenceStatus.BUSY,
  PresenceStatus.INVISIBLE,
]);

/** Whether a status means the device is reachable. @param {string} status @returns {boolean} */
export function isReachableStatus(status) {
  return REACHABLE_PRESENCE_STATUSES.includes(status);
}

/** Whether a status appears in the public online list. @param {string} status @returns {boolean} */
export function isVisibleOnlineStatus(status) {
  return VISIBLE_ONLINE_STATUSES.includes(status);
}

/** Whether a status is one a user may explicitly set. @param {string} status @returns {boolean} */
export function isUserSettableStatus(status) {
  return USER_SETTABLE_STATUSES.includes(status);
}

/**
 * Presence event types. Future Layer 6 sprints (Capability Exchange, NAT Traversal) subscribe
 * to these. See {@link module:presence/events}.
 * @readonly @enum {string}
 */
export const PresenceEventType = Object.freeze({
  REGISTERED: "presence.registered",
  UPDATED: "presence.updated",
  ONLINE: "presence.online",
  OFFLINE: "presence.offline",
  EXPIRED: "presence.expired",
  REMOVED: "presence.removed",
  RECOVERED: "presence.recovered",
  DEVICE_ADVERTISED: "presence.device_advertised",
  HEARTBEAT_RECEIVED: "presence.heartbeat_received",
  HEARTBEAT_MISSED: "presence.heartbeat_missed",
  CACHE_INVALIDATED: "presence.cache_invalidated",
});

/**
 * Machine-readable reasons attached to presence failures + validation results.
 * @readonly @enum {string}
 */
export const PresenceFailureReason = Object.freeze({
  DUPLICATE_REGISTRATION: "duplicate-registration",
  UNKNOWN_PRESENCE: "unknown-presence",
  UNKNOWN_DEVICE: "unknown-device",
  HEARTBEAT_TIMEOUT: "heartbeat-timeout",
  EXPIRED: "expired",
  INVALID_STATUS: "invalid-status",
  INVALID_TRANSITION: "invalid-transition",
  MALFORMED_METADATA: "malformed-metadata",
  UNAUTHORIZED_UPDATE: "unauthorized-update",
  CORRUPTED_ADVERTISEMENT: "corrupted-advertisement",
  INTERNAL_ERROR: "internal-error",
});

/** How a presence lookup result was sourced (observability + freshness reasoning). */
export const PresenceSource = Object.freeze({
  CACHE: "cache",
  REPOSITORY: "repository",
  NEGATIVE_CACHE: "negative-cache",
});

/** Current presence-record storage schema version (for future forward-migrations). */
export const PRESENCE_SCHEMA_VERSION = 1;

/** The framework identifier stamped onto presence records + advertisements. */
export const PRESENCE_FRAMEWORK = "presence";

/**
 * Default heartbeat cadence (ms) a client should beat at. Servers use the TIMEOUT (below), not
 * this, to decide expiry — the interval is advisory to clients.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Default heartbeat timeout (ms). A device with no heartbeat for this long is considered to
 * have missed heartbeats and is swept to `EXPIRED`. Set to ~3× the interval so a couple of
 * dropped beats are tolerated (jitter / brief network blips).
 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;

/** Default presence-cache TTL (ms) — short, because presence changes fast. */
export const DEFAULT_PRESENCE_CACHE_TTL_MS = 5_000;

/** Default negative presence-cache TTL (ms) — shorter still, so "no devices" self-heals fast. */
export const DEFAULT_PRESENCE_NEGATIVE_CACHE_TTL_MS = 2_000;

/** Default presence-cache capacity (entries) before LRU eviction. */
export const DEFAULT_PRESENCE_CACHE_LIMIT = 10_000;

/** Cap on a presence record's embedded status-history length (avoids unbounded growth). */
export const DEFAULT_STATUS_HISTORY_LIMIT = 50;

/**
 * @typedef {object} PublicIdentityDescriptor A device/user PUBLIC identity. Never a private key.
 * @property {string} identityId @property {string} publicKey base64 raw PUBLIC key
 * @property {string} algorithm @property {string} fingerprint hex SHA-256 fingerprint
 * @property {number} [version]
 */

/**
 * @typedef {object} DeviceAdvertisement A PUBLIC advertisement of one reachable device — the
 *   answer to "who is here + how do you recognize them". Carries NO transport reachability
 *   (that is a future sprint); the connection/transport blocks are inert placeholders.
 * @property {string} userId @property {string} identityId @property {string} deviceId
 * @property {PublicIdentityDescriptor|null} publicIdentity the device's PUBLIC identity
 * @property {string} status one of {@link PresenceStatus}
 * @property {string} [softwareVersion] client/app version, e.g. "1.0.0"
 * @property {string} [platform] platform descriptor, e.g. "web (Chrome on Linux)"
 * @property {object} connection FUTURE placeholder — inert connection-metadata block
 * @property {object} transport FUTURE placeholder — inert transport block
 * @property {number} version advertisement version counter
 * @property {string} advertisedAt ISO timestamp
 * @property {object} metadata free-form PUBLIC metadata
 * @property {number} schemaVersion
 */

/**
 * @typedef {object} PresenceRecord A single device's real-time presence. One record per
 *   (userId, deviceId); a user with many devices has many records (multi-device presence).
 * @property {string} presenceId stable presence id
 * @property {string} userId @property {string|null} identityId @property {string} deviceId
 * @property {string} status one of {@link PresenceStatus}
 * @property {string} registeredAt ISO timestamp presence was first registered
 * @property {string} lastSeen ISO timestamp of the last activity/heartbeat
 * @property {string} heartbeatAt ISO timestamp of the last heartbeat
 * @property {string} expiresAt ISO timestamp presence expires without a fresh heartbeat
 * @property {DeviceAdvertisement|null} advertisement the device's PUBLIC advertisement
 * @property {number} version record version counter
 * @property {Array<{from:string|null,to:string,at:string,reason?:string}>} statusHistory
 * @property {number} missedHeartbeats consecutive missed-heartbeat counter (failure detection)
 * @property {object} metadata free-form PUBLIC metadata
 * @property {number} schemaVersion
 */

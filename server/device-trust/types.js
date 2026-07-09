/**
 * @module device-trust/types
 *
 * Enums and type declarations for the Device Trust subsystem (Layer 3, Sprint 2).
 * Frozen objects act as enums in plain JS; JSDoc typedefs document the shapes.
 */

/**
 * Trust states a device can be in.
 *
 * - `TRUSTED`  — active and trusted; future secure sessions may use it.
 * - `PENDING`  — newly registered, awaiting activation/approval.
 * - `INACTIVE` — deactivated by the owner (can be re-activated).
 * - `EXPIRED`  — trusted but idle beyond the inactivity window (re-activatable).
 * - `BLOCKED`  — administratively blocked (unblockable to trusted).
 * - `REVOKED`  — permanently revoked (terminal; re-register to use again).
 * - `UNKNOWN`  — computed only: a device that is not in the registry.
 *
 * @readonly
 * @enum {string}
 */
export const TrustStatus = Object.freeze({
  TRUSTED: "trusted",
  PENDING: "pending",
  INACTIVE: "inactive",
  EXPIRED: "expired",
  BLOCKED: "blocked",
  REVOKED: "revoked",
  UNKNOWN: "unknown",
});

/** Stored (persistable) trust states — excludes the computed `UNKNOWN`. */
export const STORED_TRUST_STATUSES = Object.freeze([
  TrustStatus.TRUSTED,
  TrustStatus.PENDING,
  TrustStatus.INACTIVE,
  TrustStatus.EXPIRED,
  TrustStatus.BLOCKED,
  TrustStatus.REVOKED,
]);

/**
 * Internal device event types. Future layers subscribe to these.
 * @readonly
 * @enum {string}
 */
export const DeviceEventType = Object.freeze({
  REGISTERED: "device.registered",
  ACTIVATED: "device.activated",
  DEACTIVATED: "device.deactivated",
  REVOKED: "device.revoked",
  BLOCKED: "device.blocked",
  UNBLOCKED: "device.unblocked",
  UPDATED: "device.updated",
  DELETED: "device.deleted",
});

/**
 * Declared device capabilities. These are advertisement flags only — they grant
 * no cryptographic capability in this sprint.
 * @readonly
 * @enum {string}
 */
export const DeviceCapability = Object.freeze({
  MESSAGING: "messaging",
  MEDIA: "media",
  GROUPS: "groups",
});

/** Lifecycle actions that drive trust-state transitions. */
export const DeviceAction = Object.freeze({
  ACTIVATE: "activate",
  DEACTIVATE: "deactivate",
  REVOKE: "revoke",
  BLOCK: "block",
  UNBLOCK: "unblock",
  EXPIRE: "expire",
});

/**
 * @typedef {object} TrustedDevice
 * @property {string} deviceId
 * @property {string} identityId
 * @property {string} user owner user id
 * @property {string} publicKey base64 raw device public key
 * @property {string} algorithm
 * @property {string} fingerprint canonical hex fingerprint
 * @property {string} [name]
 * @property {string} [platform]
 * @property {string} [os]
 * @property {string} [appVersion]
 * @property {string[]} capabilities
 * @property {TrustStatus} trustStatus
 * @property {string} status legacy Sprint 1 status (active/revoked)
 * @property {string|Date} lastActive
 * @property {string|Date} [revokedAt]
 * @property {string} [revokedReason]
 * @property {string|Date} [deactivatedAt]
 * @property {object} metadata
 * @property {string|Date} createdAt
 * @property {string|Date} updatedAt
 */

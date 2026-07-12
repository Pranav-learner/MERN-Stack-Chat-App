/**
 * @module group-communication/types
 *
 * Enums + constants for the **Group Communication Engine** — Layer 10, Sprint 2. This subsystem turns
 * the Sprint-1 Group Foundation (identity + membership + roles + versioned metadata + replica state)
 * into a live, end-to-end-encrypted communication channel: secure group messaging, group key management
 * + membership rekeying, intelligent fan-out, group synchronization, and offline-member support.
 *
 * @security The ENGINE is a control plane + BLIND relay. It stores group-key METADATA only — versions,
 * epochs, opaque fingerprints (SHA-256 commitments), distribution + expiry metadata — NEVER the group
 * key bytes, message plaintext, or ciphertext-with-keys. Group keys are DEVICE-LOCAL (derived with the
 * Layer 5 HKDF primitives); the engine fans out OPAQUE ciphertext produced by the device. See
 * {@link module:group-communication/validators} for the no-secret invariant.
 *
 * @evolution Transport-INDEPENDENT. Fan-out dispatches through an INJECTED Layer 8 reliable-messaging
 * send hook; synchronization reuses the Layer 9 delta model; keys reuse the Layer 5 key hierarchy's
 * HKDF-SHA256 derivation. Future media / voice / video reuse this same engine. It does NOT implement
 * production monitoring / hardening / observability (Sprint 3) or group read receipts / delivery
 * aggregation (Sprint 4) — the events here are the seam those consume.
 */

/** The KDF + key sizing (byte-compatible with the Layer 5 key hierarchy + Web Crypto). */
export const GC_KDF = "HKDF-SHA256";
export const GC_KEY_BYTES = 32;
export const GC_NAMESPACE = "group-comm";
export const GC_VERSION = 1;

/** The subsystem identifier + schema version. */
export const GROUP_COMM_FRAMEWORK = "group-communication";
export const GROUP_COMM_SCHEMA_VERSION = 1;

/**
 * The lifecycle state of a group KEY version (epoch). @readonly @enum {string}
 */
export const GroupKeyState = Object.freeze({
  PENDING: "pending", // created, not yet active (awaiting distribution)
  ACTIVE: "active", // the current epoch used for new messages
  SUPERSEDED: "superseded", // rotated out but retained for decrypting in-flight/older messages
  EXPIRED: "expired", // past its expiry — must not be used
  REVOKED: "revoked", // forcibly invalidated (e.g. compromise)
});

export const ALL_GROUP_KEY_STATES = Object.freeze(Object.values(GroupKeyState));

/** Allowed group-key state transitions. */
export const GROUP_KEY_TRANSITIONS = Object.freeze({
  [GroupKeyState.PENDING]: Object.freeze([GroupKeyState.ACTIVE, GroupKeyState.REVOKED, GroupKeyState.EXPIRED]),
  [GroupKeyState.ACTIVE]: Object.freeze([GroupKeyState.SUPERSEDED, GroupKeyState.REVOKED, GroupKeyState.EXPIRED]),
  [GroupKeyState.SUPERSEDED]: Object.freeze([GroupKeyState.EXPIRED, GroupKeyState.REVOKED]),
  [GroupKeyState.EXPIRED]: Object.freeze([]),
  [GroupKeyState.REVOKED]: Object.freeze([]),
});

/**
 * Why a rekey (key rotation) happened. Drives forward-secrecy semantics: a `MEMBER_LEAVE` / `REMOVE` /
 * `OWNERSHIP_TRANSFER` rotation MUST use fresh randomness (the departed member must not derive the next
 * epoch), whereas a scheduled / join rotation may ratchet. @readonly @enum {string}
 */
export const RekeyTrigger = Object.freeze({
  MEMBER_JOIN: "member-join", // a new member joined — rotate so they can't read history
  MEMBER_LEAVE: "member-leave", // a member left — rotate so they can't read future
  MEMBER_REMOVE: "member-remove", // a member was removed/banned — rotate (fresh)
  OWNERSHIP_TRANSFER: "ownership-transfer", // ownership moved — rotate (fresh)
  SCHEDULED: "scheduled", // periodic rotation
  MANUAL: "manual", // an admin forced a rotation
  COMPROMISE: "compromise", // suspected compromise — rotate (fresh) + revoke old
});

export const ALL_REKEY_TRIGGERS = Object.freeze(Object.values(RekeyTrigger));

/** Triggers that REQUIRE fresh randomness (departed party must not derive the next epoch). */
export const FRESH_SECRET_TRIGGERS = Object.freeze([
  RekeyTrigger.MEMBER_LEAVE,
  RekeyTrigger.MEMBER_REMOVE,
  RekeyTrigger.OWNERSHIP_TRANSFER,
  RekeyTrigger.COMPROMISE,
]);

/**
 * The delivery state of a group message to ONE target device (a fan-out leg). @readonly @enum {string}
 */
export const GroupDeliveryState = Object.freeze({
  PLANNED: "planned", // in the fan-out plan, not yet dispatched
  QUEUED: "queued", // deferred — target is offline (pending queue)
  DISPATCHED: "dispatched", // handed to the Layer 8 reliable-messaging engine
  DELIVERED: "delivered", // Layer 8 confirmed delivery
  FAILED: "failed", // delivery failed after retries
  SKIPPED: "skipped", // intentionally not delivered (e.g. sender's own device)
});

export const ALL_GROUP_DELIVERY_STATES = Object.freeze(Object.values(GroupDeliveryState));

/** Allowed fan-out leg transitions. */
export const GROUP_DELIVERY_TRANSITIONS = Object.freeze({
  [GroupDeliveryState.PLANNED]: Object.freeze([GroupDeliveryState.QUEUED, GroupDeliveryState.DISPATCHED, GroupDeliveryState.SKIPPED]),
  [GroupDeliveryState.QUEUED]: Object.freeze([GroupDeliveryState.DISPATCHED, GroupDeliveryState.FAILED, GroupDeliveryState.SKIPPED]),
  [GroupDeliveryState.DISPATCHED]: Object.freeze([GroupDeliveryState.DELIVERED, GroupDeliveryState.FAILED, GroupDeliveryState.QUEUED]),
  [GroupDeliveryState.DELIVERED]: Object.freeze([]),
  [GroupDeliveryState.FAILED]: Object.freeze([GroupDeliveryState.QUEUED, GroupDeliveryState.DISPATCHED]),
  [GroupDeliveryState.SKIPPED]: Object.freeze([]),
});

/** The overall status of a fan-out plan. @readonly @enum {string} */
export const FanoutStatus = Object.freeze({
  PLANNING: "planning",
  IN_PROGRESS: "in-progress",
  PARTIAL: "partial", // some legs delivered, some queued/failed
  COMPLETED: "completed", // every online leg delivered (offline legs deferred)
  FAILED: "failed",
});

export const ALL_FANOUT_STATUSES = Object.freeze(Object.values(FanoutStatus));

/** Fan-out delivery priority (maps onto the Layer 8 `MessagePriority`). @readonly @enum {string} */
export const DeliveryPriority = Object.freeze({ HIGH: "high", NORMAL: "normal", LOW: "low" });
export const PRIORITY_WEIGHT = Object.freeze({ high: 2, normal: 1, low: 0 });
export const ALL_PRIORITIES = Object.freeze(Object.values(DeliveryPriority));

/**
 * The facets a group-communication replica tracks (extends the Sprint-1 replica). Used by group
 * synchronization to compute per-facet deltas. @readonly @enum {string}
 */
export const GroupSyncFacet = Object.freeze({
  MEMBERSHIP: "membership",
  METADATA: "metadata",
  KEY_VERSION: "key-version",
  REPLICA: "replica",
});

export const ALL_GROUP_SYNC_FACETS = Object.freeze(Object.values(GroupSyncFacet));

/**
 * Group-communication event types. A FUTURE Sprint 4 (Group Delivery & Read Receipt Engine) consumes
 * these. @readonly @enum {string}
 */
export const GroupCommEventType = Object.freeze({
  GROUP_MESSAGE_SENT: "group-comm.message_sent",
  GROUP_MESSAGE_RECEIVED: "group-comm.message_received",
  FANOUT_STARTED: "group-comm.fanout_started",
  FANOUT_COMPLETED: "group-comm.fanout_completed",
  DELIVERY_UPDATED: "group-comm.delivery_updated",
  MEMBER_REKEYED: "group-comm.member_rekeyed",
  GROUP_KEY_ROTATED: "group-comm.group_key_rotated",
  GROUP_KEY_EXPIRED: "group-comm.group_key_expired",
  REPLICA_UPDATED: "group-comm.replica_updated",
  SYNCHRONIZATION_STARTED: "group-comm.synchronization_started",
  SYNCHRONIZATION_COMPLETED: "group-comm.synchronization_completed",
  OFFLINE_MEMBER_QUEUED: "group-comm.offline_member_queued",
  OFFLINE_MEMBER_RESUMED: "group-comm.offline_member_resumed",
});

/** Machine-readable failure/validation reasons. */
export const GroupCommFailureReason = Object.freeze({
  UNKNOWN_GROUP: "unknown-group",
  UNKNOWN_KEY: "unknown-key",
  INVALID_KEY: "invalid-key",
  EXPIRED_KEY: "expired-key",
  STALE_KEY_VERSION: "stale-key-version",
  UNAUTHORIZED_MEMBER: "unauthorized-member",
  INVALID_FANOUT_PLAN: "invalid-fanout-plan",
  REPLICA_MISMATCH: "replica-mismatch",
  SYNC_FAILURE: "sync-failure",
  DUPLICATE_DELIVERY: "duplicate-delivery",
  UNAUTHORIZED: "unauthorized",
  MALFORMED_PAYLOAD: "malformed-payload",
  INTERNAL_ERROR: "internal-error",
});

/** Defaults (a deployment may override on the engine). */
export const DEFAULT_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DEFAULT_MAX_FANOUT = 100_000; // safety cap on a single plan's legs
export const DEFAULT_MAX_DEVICES_PER_MEMBER = 16;

/** Pagination bounds (API hardening). */
export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 100;

/**
 * @typedef {object} GroupKeyMeta Public metadata for one group-key epoch (NO secret bytes).
 * @property {string} groupId @property {number} keyVersion monotonic epoch @property {string} fingerprint
 * SHA-256 commitment @property {string} algorithm @property {string} state one of {@link GroupKeyState}
 * @property {string} trigger why it was created @property {string} createdBy @property {string} createdAt
 * @property {string|null} expiresAt @property {string} memberSetHash hash of the member set at creation
 * @property {Array<{memberId:string, delivered:boolean}>} distribution per-member distribution metadata
 */

/**
 * @typedef {object} FanoutLeg One target-device delivery in a fan-out plan.
 * @property {string} memberId @property {string} deviceId @property {boolean} online
 * @property {string} priority @property {string} state one of {@link GroupDeliveryState}
 * @property {number} attempts @property {string|null} messageRef Layer-8 message id once dispatched
 */

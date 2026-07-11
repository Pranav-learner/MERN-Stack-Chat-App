/**
 * @module synchronization/types
 *
 * Enums + constants for the **Offline Synchronization Engine** — Layer 9, Sprint 1. This subsystem
 * securely synchronizes ENCRYPTED application state (messages, conversations, delivery state, read
 * receipts, attachment metadata, transfer metadata, device metadata) between a user's authenticated
 * devices. It answers only two questions — *"what state is missing?"* (delta detection) and *"how
 * should it be synchronized?"* (a deterministic plan) — and executes resumable synchronization
 * SESSIONS. It does NOT move bytes.
 *
 * @security The engine reasons over VERSION METADATA + entity IDs ONLY — never plaintext, ciphertext
 * bytes, or key material. A replica records versions + counts + sizes; the actual (already-encrypted)
 * content is transported by the Layer-8 Data Plane, not here. See {@link module:synchronization/validators}
 * for the no-plaintext / no-secret invariant.
 *
 * @evolution Transport-INDEPENDENT: it produces a plan + operations; the CLIENT (over any Layer-7/8
 * transport) fetches/sends the content and reports progress back. It does NOT implement conflict
 * resolution, replica merge, distributed consensus, or group synchronization — those are Sprint 2. The
 * `conflict` hooks + `compression` metadata are inert seams Sprint 2 fills.
 */

/**
 * The categories of application state the engine synchronizes. Each has an independent version map on a
 * replica. @readonly @enum {string}
 */
export const SyncCategory = Object.freeze({
  CONVERSATIONS: "conversations",
  MESSAGES: "messages",
  DELIVERY: "delivery", // delivery-state updates
  READ_RECEIPTS: "read-receipts",
  ATTACHMENTS: "attachments", // attachment METADATA (not the bytes — Layer 8 moves those)
  TRANSFER_METADATA: "transfer-metadata",
  DEVICE_METADATA: "device-metadata",
});

export const ALL_SYNC_CATEGORIES = Object.freeze(Object.values(SyncCategory));

/**
 * Deterministic synchronization priority per category (higher = planned + sent first). Metadata +
 * conversations before messages before attachments, so a device becomes usable fastest.
 */
export const CATEGORY_PRIORITY = Object.freeze({
  [SyncCategory.DEVICE_METADATA]: 100,
  [SyncCategory.CONVERSATIONS]: 90,
  [SyncCategory.READ_RECEIPTS]: 70,
  [SyncCategory.DELIVERY]: 60,
  [SyncCategory.MESSAGES]: 50,
  [SyncCategory.TRANSFER_METADATA]: 30,
  [SyncCategory.ATTACHMENTS]: 20,
});

/** Rough per-item byte estimate per category (for transfer estimation; metadata only). */
export const CATEGORY_SIZE_HINT = Object.freeze({
  [SyncCategory.DEVICE_METADATA]: 256,
  [SyncCategory.CONVERSATIONS]: 512,
  [SyncCategory.READ_RECEIPTS]: 64,
  [SyncCategory.DELIVERY]: 64,
  [SyncCategory.MESSAGES]: 1024,
  [SyncCategory.TRANSFER_METADATA]: 512,
  [SyncCategory.ATTACHMENTS]: 512,
});

/**
 * A synchronization session's lifecycle state (a validated FSM — see
 * {@link module:synchronization/sessions}). @readonly @enum {string}
 */
export const SyncSessionState = Object.freeze({
  CREATED: "created", // session built, plan attached
  RUNNING: "running", // executing operations
  PAUSED: "paused", // paused (manual / backpressure); resumable
  COMPLETED: "completed", // all operations applied (terminal, success)
  CANCELLED: "cancelled", // cancelled by the owner (terminal)
  EXPIRED: "expired", // outlived its TTL (terminal)
  FAILED: "failed", // unrecoverable (terminal)
});

export const ALL_SESSION_STATES = Object.freeze(Object.values(SyncSessionState));

/** Session states in which work is still ongoing. */
export const ACTIVE_SESSION_STATES = Object.freeze([SyncSessionState.CREATED, SyncSessionState.RUNNING, SyncSessionState.PAUSED]);

/** Terminal session states. */
export const TERMINAL_SESSION_STATES = Object.freeze([SyncSessionState.COMPLETED, SyncSessionState.CANCELLED, SyncSessionState.EXPIRED, SyncSessionState.FAILED]);

export function isTerminalSessionState(s) {
  return TERMINAL_SESSION_STATES.includes(s);
}
export function isActiveSessionState(s) {
  return ACTIVE_SESSION_STATES.includes(s);
}

/** A single sync operation's state. @readonly @enum {string} */
export const SyncOperationState = Object.freeze({
  PENDING: "pending", // queued, not yet handed to the client
  IN_PROGRESS: "in-progress", // handed out, awaiting an applied report
  APPLIED: "applied", // the client applied it (terminal, success)
  FAILED: "failed", // failed to apply → retry queue
  SKIPPED: "skipped", // superseded / no longer needed (terminal)
});

/** The direction of a synchronization. */
export const SyncDirection = Object.freeze({
  PULL: "pull", // the target replica pulls missing state from a source
  PUSH: "push", // the source pushes state to a target (symmetric planning; same delta math)
});

/** Synchronization event types (a FUTURE Sprint 2 consumes these). @readonly @enum {string} */
export const SyncEventType = Object.freeze({
  REPLICA_REGISTERED: "sync.replica_registered",
  REPLICA_UPDATED: "sync.replica_updated",
  SYNC_STARTED: "sync.started",
  DELTA_GENERATED: "sync.delta_generated",
  SYNC_PLANNED: "sync.planned",
  SYNC_PROGRESS: "sync.progress",
  SYNC_PAUSED: "sync.paused",
  SYNC_RESUMED: "sync.resumed",
  SYNC_COMPLETED: "sync.completed",
  SYNC_FAILED: "sync.failed",
  SYNC_CANCELLED: "sync.cancelled",
  OPERATION_APPLIED: "sync.operation_applied",
  OPERATION_FAILED: "sync.operation_failed",
});

/** Machine-readable failure/validation reasons. */
export const SyncFailureReason = Object.freeze({
  UNKNOWN_REPLICA: "unknown-replica",
  UNKNOWN_SESSION: "unknown-session",
  INVALID_TRANSITION: "invalid-transition",
  MALFORMED_DELTA: "malformed-delta",
  INVALID_PLAN: "invalid-plan",
  EXPIRED_SESSION: "expired-session",
  UNAUTHORIZED: "unauthorized",
  DUPLICATE_OPERATION: "duplicate-operation",
  MISSING_VERSION: "missing-version",
  INTERNAL_ERROR: "internal-error",
});

/** The subsystem identifier + schema/protocol version. */
export const SYNC_FRAMEWORK = "synchronization";
export const SYNC_SCHEMA_VERSION = 1;
export const SYNC_PROTOCOL_VERSION = "1.0";

/** Default operations-per-batch when planning. */
export const DEFAULT_BATCH_SIZE = 100;
export const MAX_BATCH_SIZE = 1000;

/** Default max items a single sync plan will cover (partial sync beyond this). */
export const DEFAULT_MAX_PLAN_ITEMS = 50_000;

/** Default sync-session TTL (ms) before an incomplete session expires. */
export const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000; // 1h

/** Default max retries for a failed sync operation. */
export const DEFAULT_MAX_OP_RETRIES = 5;

/** Default replica/session cache TTL (ms) + LRU capacity. */
export const DEFAULT_CACHE_TTL_MS = 15_000;
export const DEFAULT_CACHE_LIMIT = 10_000;

/** Pagination bounds (API hardening). */
export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 100;

/**
 * @typedef {object} ReplicaState A device's synchronization replica. VERSION METADATA only — no
 *   plaintext/keys.
 * @property {string} replicaId @property {string} deviceId @property {string} userId
 * @property {Object<string, CategoryVersionMap>} categoryVersions per-category version maps
 * @property {number} syncVersion a monotonic per-replica sync counter
 * @property {string|null} lastSuccessfulSync ISO @property {number} pendingChanges
 * @property {object} metadata @property {string} createdAt @property {string} updatedAt
 * @property {number} version @property {number} schemaVersion
 */

/**
 * @typedef {object} CategoryVersionMap
 * @property {number} version the category-level high-water version (max of `entities`)
 * @property {Object<string, number>} entities entityId → version
 */

/**
 * @typedef {object} SyncDelta What a target replica is missing relative to a source. Entity REFS +
 *   versions only — never content.
 * @property {Object<string, { missing: Array<{ entityId: string, version: number }>, count: number }>} categories
 * @property {number} totalItems @property {object} metadata { generatedAt, incremental, sourceReplicaId, targetReplicaId }
 */

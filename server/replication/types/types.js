/**
 * @module replication/types
 *
 * Enums + constants for the **State Replication & Conflict Resolution** subsystem — Layer 9, Sprint 2.
 * It turns every authenticated device into a secure encrypted REPLICA and keeps replicas eventually
 * consistent by comparing them, detecting conflicts, resolving them with configurable policies, and
 * applying DETERMINISTIC merges — all without exposing plaintext.
 *
 * It extends the Sprint 1 Synchronization Engine (directional catch-up) with BIDIRECTIONAL replication:
 * where Sprint 1 tracked a plain `entityId → version` map, this subsystem tracks a richer per-entity
 * VERSION RECORD (version + writer + updatedAt + content hash + mergeable metadata) so it can tell a
 * fast-forward from a genuine conflict and merge concurrent edits.
 *
 * @security A replica holds VERSION RECORDS + entity IDs + non-secret merge METADATA (read-receipt
 * readers, delivery state, attachment size/mime/checksum) ONLY — never plaintext, ciphertext bytes, or
 * keys. The `contentHash` is an opaque digest used to DETECT divergence, not to reveal content. See
 * {@link module:replication/validators} for the no-plaintext invariant.
 *
 * @evolution Transport-INDEPENDENT. This sprint uses a SCALAR version stamp (a Sprint-1-compatible
 * linear model); the {@link module:replication/versions version} module exposes a `compareStamps` seam
 * a FUTURE vector-clock implementation drops into WITHOUT changing callers. It does NOT implement vector
 * clocks, CRDTs, distributed consensus, monitoring, or performance hardening — those are Sprint 3 / a
 * later layer. Group replication + hybrid mode reuse this subsystem.
 */

import { SyncCategory, ALL_SYNC_CATEGORIES } from "../../synchronization/types/types.js";

/** The replicated state categories (aligned with Layer 9 Sprint 1). @see SyncCategory */
export const ReplicationCategory = SyncCategory;
export const ALL_CATEGORIES = ALL_SYNC_CATEGORIES;

/**
 * How a version stamp on one replica relates to the same entity's stamp on another.
 * @readonly @enum {string}
 */
export const StampOrder = Object.freeze({
  EQUAL: "equal", // same version + same content
  DOMINATES: "dominates", // this stamp supersedes the other (fast-forward the other)
  DOMINATED: "dominated", // the other supersedes this
  CONCURRENT: "concurrent", // divergent (same version, different content) → a CONFLICT
});

/**
 * The per-entity outcome of comparing two replicas.
 * @readonly @enum {string}
 */
export const ComparisonOutcome = Object.freeze({
  ONLY_IN_SOURCE: "only-in-source", // source has it, target doesn't → replicate to target
  ONLY_IN_TARGET: "only-in-target", // target has it, source doesn't → replicate to source
  IN_SYNC: "in-sync", // identical on both
  FAST_FORWARD_TARGET: "fast-forward-target", // source is newer → target catches up (no conflict)
  FAST_FORWARD_SOURCE: "fast-forward-source", // target is newer → source catches up
  CONFLICT: "conflict", // concurrent divergent edits → resolve by policy
  MERGE: "merge", // a mergeable category → deterministic union/max (lossless)
});

/**
 * Configurable conflict-resolution policies. @readonly @enum {string}
 */
export const ConflictPolicy = Object.freeze({
  LAST_WRITE_WINS: "last-write-wins", // newest updatedAt (tie → higher writerReplicaId)
  SERVER_AUTHORITY: "server-authority", // the authoritative replica's record wins
  MERGE: "merge", // deterministic category merge
  CUSTOM: "custom", // an injected resolver decides
});

export const ALL_CONFLICT_POLICIES = Object.freeze(Object.values(ConflictPolicy));

/** Deterministic merge strategy per category. @readonly @enum {string} */
export const MergeStrategy = Object.freeze({
  READ_RECEIPT_UNION: "read-receipt-union", // union readers, max readAt per reader (monotonic)
  DELIVERY_MAX_STATE: "delivery-max-state", // most-advanced delivery state wins
  ATTACHMENT_FIELD_MERGE: "attachment-field-merge", // field-wise (max size, prefer-defined)
  METADATA_FIELD_MERGE: "metadata-field-merge", // generic field-wise metadata merge
  OPAQUE_LWW: "opaque-lww", // opaque content → last-write-wins (no field merge)
});

/**
 * Which categories MERGE deterministically vs. resolve as an opaque conflict. Mergeable categories are
 * lossless (union / max); messages carry opaque encrypted content, so they default to a policy.
 */
export const CATEGORY_MERGE_STRATEGY = Object.freeze({
  [ReplicationCategory.READ_RECEIPTS]: MergeStrategy.READ_RECEIPT_UNION,
  [ReplicationCategory.DELIVERY]: MergeStrategy.DELIVERY_MAX_STATE,
  [ReplicationCategory.ATTACHMENTS]: MergeStrategy.ATTACHMENT_FIELD_MERGE,
  [ReplicationCategory.TRANSFER_METADATA]: MergeStrategy.METADATA_FIELD_MERGE,
  [ReplicationCategory.CONVERSATIONS]: MergeStrategy.METADATA_FIELD_MERGE,
  [ReplicationCategory.DEVICE_METADATA]: MergeStrategy.METADATA_FIELD_MERGE,
  [ReplicationCategory.MESSAGES]: MergeStrategy.OPAQUE_LWW,
});

/** The default conflict policy per category (a deployment can override). */
export const DEFAULT_CATEGORY_POLICY = Object.freeze({
  [ReplicationCategory.MESSAGES]: ConflictPolicy.LAST_WRITE_WINS,
  [ReplicationCategory.CONVERSATIONS]: ConflictPolicy.MERGE,
  [ReplicationCategory.DELIVERY]: ConflictPolicy.MERGE,
  [ReplicationCategory.READ_RECEIPTS]: ConflictPolicy.MERGE,
  [ReplicationCategory.ATTACHMENTS]: ConflictPolicy.MERGE,
  [ReplicationCategory.TRANSFER_METADATA]: ConflictPolicy.MERGE,
  [ReplicationCategory.DEVICE_METADATA]: ConflictPolicy.MERGE,
});

/** Whether a category merges losslessly (union/max) rather than picking a single winner. */
export function isMergeableCategory(category) {
  const s = CATEGORY_MERGE_STRATEGY[category];
  return s && s !== MergeStrategy.OPAQUE_LWW;
}

/** Delivery-state rank (higher = more advanced). Used by the delivery merge. */
export const DELIVERY_RANK = Object.freeze({ pending: 0, sent: 1, delivered: 2, read: 3 });

/** Ordered delivery states (for deterministic max). */
export const DELIVERY_STATES = Object.freeze(["pending", "sent", "delivered", "read"]);

/** Replication event types (a FUTURE Layer 10 consumes these). @readonly @enum {string} */
export const ReplicationEventType = Object.freeze({
  REPLICA_REGISTERED: "replication.replica_registered",
  REPLICA_UPDATED: "replication.replica_updated",
  REPLICA_COMPARED: "replication.replica_compared",
  CONFLICT_DETECTED: "replication.conflict_detected",
  CONFLICT_RESOLVED: "replication.conflict_resolved",
  MERGE_STARTED: "replication.merge_started",
  MERGE_COMPLETED: "replication.merge_completed",
  DELTA_REPLICATED: "replication.delta_replicated",
  SYNCHRONIZATION_RESUMED: "replication.synchronization_resumed",
  REPLICATION_FAILED: "replication.replication_failed",
});

/** Machine-readable failure/validation reasons. */
export const ReplicationFailureReason = Object.freeze({
  UNKNOWN_REPLICA: "unknown-replica",
  DUPLICATE_REPLICA: "duplicate-replica",
  VERSION_CONFLICT: "version-conflict",
  INVALID_MERGE: "invalid-merge",
  CORRUPTED_DELTA: "corrupted-delta",
  REPLAY_DETECTED: "replay-detected",
  MALFORMED_METADATA: "malformed-metadata",
  UNAUTHORIZED: "unauthorized",
  UNRESOLVED_CONFLICT: "unresolved-conflict",
  INTERNAL_ERROR: "internal-error",
});

/** The subsystem identifier + schema version. */
export const REPLICATION_FRAMEWORK = "replication";
export const REPLICATION_SCHEMA_VERSION = 1;

/** Default replay-cache size (seen delta ids) for replay protection. */
export const DEFAULT_REPLAY_CACHE_SIZE = 8192;

/** Default max entities a single replication delta will carry (partial replication beyond this). */
export const DEFAULT_MAX_DELTA_ITEMS = 50_000;

/** Pagination bounds (API hardening). */
export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 100;

/**
 * @typedef {object} EntityVersion A per-entity version record on a replica. METADATA only.
 * @property {string} entityId @property {number} version scalar version stamp (vector-clock seam)
 * @property {string} writerReplicaId which replica last wrote this @property {string} updatedAt ISO
 * @property {string} contentHash opaque digest of the (encrypted) content — divergence detection, not content
 * @property {boolean} [deleted] tombstone @property {object} [meta] category-specific mergeable metadata (no plaintext)
 */

/**
 * @typedef {object} ReplicaSnapshot A device's full replica state.
 * @property {string} replicaId @property {string} deviceId @property {string} userId
 * @property {Object<string, Object<string, EntityVersion>>} categories category → (entityId → EntityVersion)
 * @property {number} replicaVersion monotonic overall counter @property {object} metadata
 * @property {string} createdAt @property {string} updatedAt @property {number} version @property {number} schemaVersion
 */

/**
 * @typedef {object} Conflict A detected concurrent divergence for one entity.
 * @property {string} category @property {string} entityId
 * @property {EntityVersion} source @property {EntityVersion} target
 * @property {string} outcome one of {@link ComparisonOutcome} @property {object} metadata
 */

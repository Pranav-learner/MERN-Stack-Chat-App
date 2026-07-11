/**
 * @module transport-reliability/types
 *
 * Enums + constants for the **Data Plane Reliability & Production Hardening** subsystem — Layer 8,
 * Sprint 3, the capstone that makes the peer-to-peer Data Plane production-grade. It does NOT move
 * bytes: it makes the TRANSFERS produced by the Reliable Messaging Engine (Sprint 1) + the Transport
 * Engine (Sprint 2) *reliable* — interrupted-transfer recovery, resume-from-checkpoint, connection
 * migration, continuous health monitoring, observability, security validation, and a protocol freeze.
 *
 * @security This subsystem operates on transfer CONTROL-PLANE metadata + numeric aggregates only —
 * transfer ids, chunk counts, byte totals, states, throughput, health scores, recovery reasons. It
 * NEVER handles plaintext, ciphertext bytes, a private/session/message key, or a chunk's payload.
 * Recovery + migration PRESERVE transfer state (the acked/received checkpoint) so a resume re-sends
 * only the missing chunks; they never touch payload bytes or keys.
 *
 * @evolution Transport-INDEPENDENT: it tracks an abstract transfer-reliability record + reacts via
 * INJECTED recovery / migration hooks (resume / retry / migrate / validate connection). It integrates
 * with Layer 7's Connection Manager (via injected hooks) to migrate a transfer onto a new Active
 * Connection. Layer 9 (offline encrypted sync) builds on the frozen interfaces here.
 */

// === transfer reliability lifecycle =======================================

/**
 * The reliability layer's view of a transfer's health/continuity state (a validated FSM — see
 * {@link module:transport-reliability/manager}). Distinct from the Transport Engine's transfer FSM;
 * this tracks reliability, not fragmentation progress.
 * @readonly @enum {string}
 */
export const ReliabilityState = Object.freeze({
  TRACKING: "tracking", // registered + progressing healthily
  DEGRADED: "degraded", // progressing but unhealthy (high retry / low throughput)
  INTERRUPTED: "interrupted", // stalled / connection lost — awaiting recovery
  RECOVERING: "recovering", // running a recovery plan (resume from checkpoint)
  MIGRATING: "migrating", // moving to a new Active Connection
  COMPLETED: "completed", // the transfer finished successfully (terminal)
  FAILED: "failed", // recovery exhausted / unrecoverable (terminal)
  ABANDONED: "abandoned", // cancelled / expired by the owner (terminal)
});

export const ALL_RELIABILITY_STATES = Object.freeze(Object.values(ReliabilityState));

/** States in which the transfer is still being tracked / worked. */
export const ACTIVE_RELIABILITY_STATES = Object.freeze([
  ReliabilityState.TRACKING,
  ReliabilityState.DEGRADED,
  ReliabilityState.INTERRUPTED,
  ReliabilityState.RECOVERING,
  ReliabilityState.MIGRATING,
]);

/** Terminal reliability states. */
export const TERMINAL_RELIABILITY_STATES = Object.freeze([ReliabilityState.COMPLETED, ReliabilityState.FAILED, ReliabilityState.ABANDONED]);

export function isTerminalReliabilityState(s) {
  return TERMINAL_RELIABILITY_STATES.includes(s);
}
export function isActiveReliabilityState(s) {
  return ACTIVE_RELIABILITY_STATES.includes(s);
}

// === recovery =============================================================

/**
 * What interrupted a transfer / triggered a recovery. Each maps to a recovery action.
 * @readonly @enum {string}
 */
export const RecoveryTrigger = Object.freeze({
  CONNECTION_LOSS: "connection-loss", // the Active Connection dropped
  TEMPORARY_FAILURE: "temporary-failure", // a transient send/store failure
  CHUNK_TIMEOUT: "chunk-timeout", // chunks stopped being acknowledged
  STALL_TIMEOUT: "stall-timeout", // no progress for too long
  INTERRUPTED_TRANSFER: "interrupted-transfer", // an explicit interruption (app/network)
  NETWORK_CHANGE: "network-change", // interface changed (see MigrationTrigger)
  REPOSITORY_FAILURE: "repository-failure", // a storage failure
});

export const ALL_RECOVERY_TRIGGERS = Object.freeze(Object.values(RecoveryTrigger));

/**
 * The action a recovery performs. All PRESERVE the transfer's checkpoint (resume, never restart from
 * zero). @readonly @enum {string}
 */
export const RecoveryAction = Object.freeze({
  RESUME_FROM_CHECKPOINT: "resume-from-checkpoint", // re-send only the missing chunks
  RETRY: "retry", // retry over the same connection
  MIGRATE: "migrate", // move to a new Active Connection, then resume
  GRACEFUL_FAIL: "graceful-fail", // give up cleanly (recovery exhausted) — state intact
});

/** Which action + recoverability each trigger defaults to. */
export const RECOVERY_PLANS = Object.freeze({
  [RecoveryTrigger.CONNECTION_LOSS]: { action: RecoveryAction.MIGRATE, recoverable: true },
  [RecoveryTrigger.TEMPORARY_FAILURE]: { action: RecoveryAction.RETRY, recoverable: true },
  [RecoveryTrigger.CHUNK_TIMEOUT]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.STALL_TIMEOUT]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.INTERRUPTED_TRANSFER]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.NETWORK_CHANGE]: { action: RecoveryAction.MIGRATE, recoverable: true },
  [RecoveryTrigger.REPOSITORY_FAILURE]: { action: RecoveryAction.RETRY, recoverable: true },
});

/** The outcome of a recovery attempt. */
export const RecoveryOutcome = Object.freeze({ RECOVERED: "recovered", MIGRATED: "migrated", FAILED: "failed", EXHAUSTED: "exhausted" });

// === connection migration =================================================

/** What triggered a connection migration. @readonly @enum {string} */
export const MigrationTrigger = Object.freeze({
  CONNECTION_REPLACED: "connection-replaced", // Layer 7 replaced the Active Connection
  CONNECTION_LOST: "connection-lost", // the connection dropped; a new one is available
  WIFI_TO_MOBILE: "wifi-to-mobile", // device network changed WiFi → cellular
  MOBILE_TO_WIFI: "mobile-to-wifi", // device network changed cellular → WiFi
  MANUAL: "manual", // an explicit migration request
});

export const ALL_MIGRATION_TRIGGERS = Object.freeze(Object.values(MigrationTrigger));

/** Migration outcome. */
export const MigrationOutcome = Object.freeze({ MIGRATED: "migrated", REJECTED: "rejected", FAILED: "failed" });

// === health ===============================================================

/** Transfer health status. @readonly @enum {string} */
export const HealthStatus = Object.freeze({ HEALTHY: "healthy", DEGRADED: "degraded", UNHEALTHY: "unhealthy", UNKNOWN: "unknown" });

/** Health-score dimension weights (sum → 1). Higher score = healthier. */
export const HEALTH_WEIGHTS = Object.freeze({ progress: 0.3, throughput: 0.25, reliability: 0.25, freshness: 0.2 });

/** Retry-rate (retries per acked chunk) at/above which the reliability dimension scores 0. */
export const RETRY_RATE_CEILING = 2;
/** Staleness (ms since last activity) at/above which the freshness dimension scores 0. */
export const STALENESS_CEILING_MS = 30_000;

// === observability ========================================================

export const MetricType = Object.freeze({ COUNTER: "counter", GAUGE: "gauge", HISTOGRAM: "histogram" });

/** Canonical transport-reliability metric names (stable — frozen interface). */
export const Metric = Object.freeze({
  TRANSFER_TOTAL: "transport_transfer_total",
  TRANSFER_SUCCESS: "transport_transfer_success_total",
  TRANSFER_FAILURE: "transport_transfer_failure_total",
  TRANSFER_LATENCY: "transport_transfer_latency_ms",
  TRANSFER_THROUGHPUT: "transport_transfer_throughput_bytes_per_sec",
  CHUNK_SIZE: "transport_chunk_size_bytes",
  RETRY_TOTAL: "transport_retry_total",
  RESUME_TOTAL: "transport_resume_total",
  RECOVERY_TOTAL: "transport_recovery_total",
  RECOVERY_SUCCESS: "transport_recovery_success_total",
  RECOVERY_FAILURE: "transport_recovery_failure_total",
  RECOVERY_TIME: "transport_recovery_time_ms",
  MIGRATION_TOTAL: "transport_migration_total",
  MIGRATION_SUCCESS: "transport_migration_success_total",
  QUEUE_LENGTH: "transport_queue_length",
  OUTSTANDING_CHUNKS: "transport_outstanding_chunks",
  BACKPRESSURE_TOTAL: "transport_backpressure_total",
  CONCURRENT_TRANSFERS: "transport_concurrent_transfers",
  HEALTH_SCORE: "transport_health_score",
  ALERT_TOTAL: "transport_alert_total",
});

/** Reliability event types (emitted on the {@link module:transport-reliability/events bus}). */
export const ReliabilityEventType = Object.freeze({
  TRANSFER_REGISTERED: "transport-reliability.transfer_registered",
  CHECKPOINT_RECORDED: "transport-reliability.checkpoint_recorded",
  STATE_CHANGED: "transport-reliability.state_changed",
  HEALTH_CHANGED: "transport-reliability.health_changed",
  TRANSFER_INTERRUPTED: "transport-reliability.transfer_interrupted",
  RECOVERY_STARTED: "transport-reliability.recovery_started",
  RECOVERY_SUCCEEDED: "transport-reliability.recovery_succeeded",
  RECOVERY_FAILED: "transport-reliability.recovery_failed",
  RESUME_PLANNED: "transport-reliability.resume_planned",
  MIGRATION_STARTED: "transport-reliability.migration_started",
  MIGRATION_SUCCEEDED: "transport-reliability.migration_succeeded",
  MIGRATION_FAILED: "transport-reliability.migration_failed",
  TRANSFER_COMPLETED: "transport-reliability.transfer_completed",
  TRANSFER_FAILED: "transport-reliability.transfer_failed",
  ALERT_RAISED: "transport-reliability.alert_raised",
  CACHE_INVALIDATED: "transport-reliability.cache_invalidated",
});

/** Alert types the {@link module:transport-reliability/monitoring monitor} raises. */
export const AlertType = Object.freeze({
  TRANSFER_FAILURE_SPIKE: "transfer-failure-spike",
  REPEATED_RECOVERY_FAILURE: "repeated-recovery-failure",
  UNHEALTHY_TRANSFER: "unhealthy-transfer",
  STALL_TIMEOUT: "stall-timeout",
  RETRY_STORM: "retry-storm",
  BACKPRESSURE_STORM: "backpressure-storm",
  MIGRATION_STORM: "migration-storm",
});

export const AlertSeverity = Object.freeze({ INFO: "info", WARNING: "warning", CRITICAL: "critical" });

/** Machine-readable failure/validation reasons. */
export const ReliabilityFailureReason = Object.freeze({
  UNKNOWN_TRANSFER: "unknown-transfer",
  INVALID_TRANSITION: "invalid-transition",
  RECOVERY_EXHAUSTED: "recovery-exhausted",
  UNRECOVERABLE: "unrecoverable",
  MALFORMED_RECORD: "malformed-record",
  UNAUTHORIZED: "unauthorized",
  MIGRATION_REJECTED: "migration-rejected",
  INTERNAL_ERROR: "internal-error",
});

// === constants ============================================================

export const TRANSREL_FRAMEWORK = "transport-reliability";
export const TRANSREL_SCHEMA_VERSION = 1;

/** The frozen Layer-8 Data Plane version (bump = breaking change). */
export const DATA_PLANE_VERSION = "1.0";

/** Default stall timeout (ms): no progress this long → the transfer is considered interrupted. */
export const DEFAULT_STALL_TIMEOUT_MS = 20_000;

/** Default recovery timeout (ms) — total time a recovery may spend before graceful failure. */
export const DEFAULT_RECOVERY_TIMEOUT_MS = 60_000;

/** Default reliability-record TTL (ms) before an inactive record expires. */
export const DEFAULT_TRANSFER_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/** Default retry policy for recovery attempts. */
export const DEFAULT_RETRY_POLICY = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 16_000,
  factor: 2,
  jitter: true,
  cooldownMs: 1_000,
  recoveryTimeoutMs: DEFAULT_RECOVERY_TIMEOUT_MS,
});

/** Default monitor window (ms) + alert thresholds per window. */
export const DEFAULT_MONITOR_WINDOW_MS = 60_000;
export const DEFAULT_ALERT_THRESHOLDS = Object.freeze({
  [AlertType.TRANSFER_FAILURE_SPIKE]: 10,
  [AlertType.REPEATED_RECOVERY_FAILURE]: 3,
  [AlertType.UNHEALTHY_TRANSFER]: 1,
  [AlertType.STALL_TIMEOUT]: 5,
  [AlertType.RETRY_STORM]: 100,
  [AlertType.BACKPRESSURE_STORM]: 50,
  [AlertType.MIGRATION_STORM]: 10,
});

/** Default reliability-record cache TTL (ms) + LRU capacity. */
export const DEFAULT_CACHE_TTL_MS = 10_000;
export const DEFAULT_CACHE_LIMIT = 20_000;

/** Pagination bounds (API hardening). */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * @typedef {object} TransferReliabilityRecord The reliability layer's view of a transfer. CONTROL-
 *   PLANE metadata only — no payload bytes, no keys.
 * @property {string} transferId @property {string} conversationId
 * @property {string} senderDeviceId @property {string} receiverDeviceId
 * @property {string|null} connectionId the Active Connection carrying it (migrates)
 * @property {string} state one of {@link ReliabilityState}
 * @property {string} priority @property {object} checkpoint {@link TransferCheckpoint}
 * @property {object} health {@link TransferHealth}
 * @property {number} recoveryCount @property {number} resumeCount @property {number} migrationCount
 * @property {object} retryPolicy @property {object} metadata
 * @property {string} registeredAt @property {string} updatedAt @property {string} lastActivityAt
 * @property {string} expiresAt @property {number} version @property {number} schemaVersion
 */

/**
 * @typedef {object} TransferCheckpoint The resumable progress of a transfer. Chunk COUNTS + a high-
 *   water mark only — no bytes.
 * @property {number} totalChunks @property {number} chunksAcked @property {number} bytesTransferred
 * @property {number} highWaterMark highest contiguously-acknowledged chunk index (resume point)
 * @property {number[]} [missingIndices] optional precise gap list for partial recovery
 * @property {number} outstanding chunks in flight @property {number} retryCount
 * @property {string} checkpointAt ISO
 */

/**
 * @typedef {object} TransferHealth
 * @property {string} status one of {@link HealthStatus} @property {number} score `[0,1]`
 * @property {number} throughputBytesPerSec @property {number} retryRate @property {number} failureRate
 * @property {number} outstanding @property {number} stalenessMs @property {number} progress `[0,1]`
 */

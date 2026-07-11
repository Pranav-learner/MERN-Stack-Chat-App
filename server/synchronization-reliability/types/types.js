/**
 * @module synchronization-reliability/types
 *
 * Enums + constants for the **Synchronization Reliability & Production Hardening** subsystem — Layer 9,
 * Sprint 3, the capstone that makes the offline-synchronization + state-replication layer production-
 * grade. It does NOT synchronize state itself: it makes the SYNCHRONIZATION SESSIONS (Sprint 1) +
 * REPLICAS (Sprint 2) *reliable* — interrupted-sync recovery, device-crash / app-restart resume,
 * continuous health monitoring, replica-drift tracking, configurable retry policies, observability,
 * security validation, and a protocol freeze.
 *
 * @security This subsystem operates on synchronization CONTROL-PLANE metadata + numeric aggregates
 * only — session ids, replica ids, operation counts, conflict counts, versions, health scores,
 * recovery reasons. It NEVER handles plaintext, ciphertext, message content, or key material. Recovery
 * PRESERVES replica consistency (the monotonic sync checkpoint) so a resume re-runs only the remaining
 * operations; it never touches content or keys.
 *
 * @evolution Transport-INDEPENDENT: it tracks an abstract sync-reliability record + reacts via INJECTED
 * recovery hooks (resume / retry / restart). It integrates with the Layer 8 Transport Engine (attachment
 * transfer resume) + the Sprint 1/2 engines via injected hooks. Layer 10 (secure group communication)
 * builds on the frozen interfaces here. It does NOT implement group messaging/replication, CRDTs,
 * distributed consensus, or voice/video.
 */

// === reliability lifecycle ================================================

/**
 * The reliability layer's view of a synchronization's health/continuity state (a validated FSM — see
 * {@link module:synchronization-reliability/manager}). Distinct from the Sprint 1 session FSM; this
 * tracks reliability, not sync progress.
 * @readonly @enum {string}
 */
export const ReliabilityState = Object.freeze({
  TRACKING: "tracking", // registered + progressing healthily
  DEGRADED: "degraded", // progressing but unhealthy (high conflict rate / low throughput / drift)
  INTERRUPTED: "interrupted", // stalled / crashed / disconnected — awaiting recovery
  RECOVERING: "recovering", // running a recovery plan (resume from checkpoint)
  COMPLETED: "completed", // the synchronization finished successfully (terminal)
  FAILED: "failed", // recovery exhausted / unrecoverable (terminal)
  ABANDONED: "abandoned", // cancelled / expired by the owner (terminal)
});

export const ALL_RELIABILITY_STATES = Object.freeze(Object.values(ReliabilityState));

/** States in which the synchronization is still being tracked / worked. */
export const ACTIVE_RELIABILITY_STATES = Object.freeze([
  ReliabilityState.TRACKING,
  ReliabilityState.DEGRADED,
  ReliabilityState.INTERRUPTED,
  ReliabilityState.RECOVERING,
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
 * What interrupted a synchronization / triggered a recovery. @readonly @enum {string}
 */
export const RecoveryTrigger = Object.freeze({
  INTERRUPTED_SYNC: "interrupted-sync", // an explicit interruption mid-sync
  DEVICE_CRASH: "device-crash", // the device crashed + came back
  APP_RESTART: "app-restart", // the app restarted (durable checkpoint resumes)
  CONNECTION_LOSS: "connection-loss", // the connection dropped
  PARTIAL_SYNC: "partial-sync", // only part of the plan applied
  TRANSFER_FAILURE: "transfer-failure", // an underlying Layer-8 transfer failed
  STALL_TIMEOUT: "stall-timeout", // no progress for too long
  REPOSITORY_FAILURE: "repository-failure", // a storage failure
});

export const ALL_RECOVERY_TRIGGERS = Object.freeze(Object.values(RecoveryTrigger));

/**
 * The action a recovery performs. All PRESERVE replica consistency (resume from the checkpoint; never
 * silently drop applied operations). @readonly @enum {string}
 */
export const RecoveryAction = Object.freeze({
  RESUME_FROM_CHECKPOINT: "resume-from-checkpoint", // re-run only the remaining operations
  RETRY: "retry", // retry the current step
  RESTART: "restart", // re-plan + restart the sync (delta recomputed; still consistent)
  GRACEFUL_FAIL: "graceful-fail", // give up cleanly (recovery exhausted) — checkpoint intact
});

/** Which action + recoverability each trigger defaults to. */
export const RECOVERY_PLANS = Object.freeze({
  [RecoveryTrigger.INTERRUPTED_SYNC]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.DEVICE_CRASH]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.APP_RESTART]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.CONNECTION_LOSS]: { action: RecoveryAction.RETRY, recoverable: true },
  [RecoveryTrigger.PARTIAL_SYNC]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.TRANSFER_FAILURE]: { action: RecoveryAction.RETRY, recoverable: true },
  [RecoveryTrigger.STALL_TIMEOUT]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.REPOSITORY_FAILURE]: { action: RecoveryAction.RESTART, recoverable: true },
});

/** The outcome of a recovery attempt. */
export const RecoveryOutcome = Object.freeze({ RECOVERED: "recovered", FAILED: "failed", EXHAUSTED: "exhausted" });

// === retry ================================================================

/** Retry strategies. @readonly @enum {string} */
export const RetryStrategy = Object.freeze({
  IMMEDIATE: "immediate",
  EXPONENTIAL_BACKOFF: "exponential-backoff",
  FIXED: "fixed",
  NONE: "none",
});

/** Default retry policy for recovery attempts. */
export const DEFAULT_RETRY_POLICY = Object.freeze({
  strategy: RetryStrategy.EXPONENTIAL_BACKOFF,
  maxAttempts: 5,
  retryBudget: 20, // total retries allowed across a record's life
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: true,
  cooldownMs: 1_000,
  recoveryTimeoutMs: 120_000,
  autoResume: true,
});

// === health ===============================================================

/** Synchronization health status. @readonly @enum {string} */
export const HealthStatus = Object.freeze({ HEALTHY: "healthy", DEGRADED: "degraded", UNHEALTHY: "unhealthy", UNKNOWN: "unknown" });

/** Health-score dimension weights (sum → 1). Higher score = healthier. */
export const HEALTH_WEIGHTS = Object.freeze({ progress: 0.3, reliability: 0.3, drift: 0.2, freshness: 0.2 });

/** Conflict rate (conflicts per completed op) at/above which the reliability dimension scores 0. */
export const CONFLICT_RATE_CEILING = 0.5;
/** Replica drift (pending items) at/above which the drift dimension scores 0. */
export const DRIFT_CEILING = 1_000;
/** Staleness (ms since last activity) at/above which the freshness dimension scores 0. */
export const STALENESS_CEILING_MS = 60_000;

// === observability ========================================================

export const MetricType = Object.freeze({ COUNTER: "counter", GAUGE: "gauge", HISTOGRAM: "histogram" });

/** Canonical sync-reliability metric names (stable — frozen interface). */
export const Metric = Object.freeze({
  SYNC_TOTAL: "sync_total",
  SYNC_SUCCESS: "sync_success_total",
  SYNC_FAILURE: "sync_failure_total",
  SYNC_LATENCY: "sync_latency_ms",
  SYNC_THROUGHPUT: "sync_throughput_ops_per_sec",
  CONFLICT_TOTAL: "sync_conflict_total",
  CONFLICT_RATE: "sync_conflict_rate",
  MERGE_TOTAL: "sync_merge_total",
  MERGE_SUCCESS: "sync_merge_success_total",
  RECOVERY_TOTAL: "sync_recovery_total",
  RECOVERY_SUCCESS: "sync_recovery_success_total",
  RECOVERY_FAILURE: "sync_recovery_failure_total",
  RECOVERY_TIME: "sync_recovery_time_ms",
  RESUME_TOTAL: "sync_resume_total",
  RETRY_TOTAL: "sync_retry_total",
  REPLICA_DRIFT: "sync_replica_drift",
  PENDING_OPERATIONS: "sync_pending_operations",
  QUEUE_DEPTH: "sync_queue_depth",
  CONCURRENT_SYNCS: "sync_concurrent",
  HEALTH_SCORE: "sync_health_score",
  ALERT_TOTAL: "sync_alert_total",
});

/** Reliability event types (a FUTURE Layer 10 consumes these). @readonly @enum {string} */
export const ReliabilityEventType = Object.freeze({
  SYNC_REGISTERED: "sync-reliability.registered",
  CHECKPOINT_RECORDED: "sync-reliability.checkpoint_recorded",
  STATE_CHANGED: "sync-reliability.state_changed",
  HEALTH_CHANGED: "sync-reliability.health_changed",
  SYNC_INTERRUPTED: "sync-reliability.interrupted",
  RECOVERY_STARTED: "sync-reliability.recovery_started",
  RECOVERY_SUCCEEDED: "sync-reliability.recovery_succeeded",
  RECOVERY_FAILED: "sync-reliability.recovery_failed",
  SYNC_RESUMED: "sync-reliability.resumed",
  DRIFT_DETECTED: "sync-reliability.drift_detected",
  SYNC_COMPLETED: "sync-reliability.completed",
  SYNC_FAILED: "sync-reliability.failed",
  ALERT_RAISED: "sync-reliability.alert_raised",
});

/** Alert types the {@link module:synchronization-reliability/monitoring monitor} raises. */
export const AlertType = Object.freeze({
  SYNC_FAILURE_SPIKE: "sync-failure-spike",
  REPEATED_RECOVERY_FAILURE: "repeated-recovery-failure",
  UNHEALTHY_REPLICA: "unhealthy-replica",
  STALL_TIMEOUT: "stall-timeout",
  HIGH_CONFLICT_RATE: "high-conflict-rate",
  HIGH_REPLICA_DRIFT: "high-replica-drift",
  RETRY_STORM: "retry-storm",
});

export const AlertSeverity = Object.freeze({ INFO: "info", WARNING: "warning", CRITICAL: "critical" });

/** Machine-readable failure/validation reasons. */
export const ReliabilityFailureReason = Object.freeze({
  UNKNOWN_SYNC: "unknown-sync",
  INVALID_TRANSITION: "invalid-transition",
  RECOVERY_EXHAUSTED: "recovery-exhausted",
  UNRECOVERABLE: "unrecoverable",
  MALFORMED_RECORD: "malformed-record",
  UNAUTHORIZED: "unauthorized",
  RETRY_BUDGET_EXCEEDED: "retry-budget-exceeded",
  INTERNAL_ERROR: "internal-error",
});

// === constants ============================================================

export const SYNCREL_FRAMEWORK = "synchronization-reliability";
export const SYNCREL_SCHEMA_VERSION = 1;

/** The frozen Layer-9 synchronization layer version (bump = breaking change). */
export const SYNC_LAYER_VERSION = "1.0";

/** Default stall timeout (ms): no progress this long → the sync is considered interrupted. */
export const DEFAULT_STALL_TIMEOUT_MS = 45_000;

/** Default sync-reliability record TTL (ms) before an inactive record expires. */
export const DEFAULT_SYNC_TTL_MS = 24 * 60 * 60 * 1000; // 24h (offline devices may be away a while)

/** Default monitor window (ms) + alert thresholds per window. */
export const DEFAULT_MONITOR_WINDOW_MS = 60_000;
export const DEFAULT_ALERT_THRESHOLDS = Object.freeze({
  [AlertType.SYNC_FAILURE_SPIKE]: 10,
  [AlertType.REPEATED_RECOVERY_FAILURE]: 3,
  [AlertType.UNHEALTHY_REPLICA]: 1,
  [AlertType.STALL_TIMEOUT]: 5,
  [AlertType.HIGH_CONFLICT_RATE]: 1,
  [AlertType.HIGH_REPLICA_DRIFT]: 1,
  [AlertType.RETRY_STORM]: 100,
});

/** Pagination bounds (API hardening). */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * @typedef {object} SyncReliabilityRecord The reliability layer's view of a synchronization. CONTROL-
 *   PLANE metadata only — no content, no keys.
 * @property {string} syncId @property {string} sessionId the Sprint-1 sync session id
 * @property {string} replicaId @property {string} deviceId @property {string} userId
 * @property {string} state one of {@link ReliabilityState}
 * @property {object} checkpoint {@link SyncCheckpoint} @property {object} health {@link SyncHealth}
 * @property {number} recoveryCount @property {number} resumeCount @property {number} retryCount
 * @property {object} retryPolicy @property {object} metadata
 * @property {string} registeredAt @property {string} updatedAt @property {string} lastActivityAt @property {string} expiresAt
 * @property {number} version @property {number} schemaVersion
 */

/**
 * @typedef {object} SyncCheckpoint The resumable progress of a synchronization. Counts only — no content.
 * @property {number} totalOperations @property {number} completedOperations @property {number} cursor
 * @property {number} conflicts @property {number} merges @property {number} pendingOperations
 * @property {number} replicaDrift entities the replica is still behind on @property {string} checkpointAt
 */

/**
 * @typedef {object} SyncHealth
 * @property {string} status one of {@link HealthStatus} @property {number} score `[0,1]`
 * @property {number} progress @property {number} conflictRate @property {number} mergeSuccessRate
 * @property {number} replicaDrift @property {number} stalenessMs @property {number} throughput
 */

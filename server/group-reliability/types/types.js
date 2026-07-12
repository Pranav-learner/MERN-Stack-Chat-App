/**
 * @module group-reliability/types
 *
 * Enums + constants for the **Group Reliability & Production Hardening** subsystem — Layer 10, Sprint 3,
 * the capstone that makes the Group Communication platform (Group Foundation Sprint 1 + Group
 * Communication Engine Sprint 2) production-grade. It does NOT send messages, rotate keys, or fan out
 * itself: it makes those GROUP OPERATIONS *reliable* — interrupted-messaging / failed-fan-out / rekey /
 * membership / replica / synchronization / offline recovery, continuous health monitoring, configurable
 * retry policies, observability (metrics + Prometheus/OTel hooks), security validation, and a protocol
 * freeze.
 *
 * @security This subsystem operates on group CONTROL-PLANE metadata + numeric aggregates ONLY — group
 * ids, operation ids, target/leg counts, key versions, health scores, recovery reasons. It NEVER handles
 * message plaintext, ciphertext, or key material. Recovery PRESERVES consistency (the monotonic
 * operation checkpoint) so a resume re-runs only the remaining targets; it never touches content or keys.
 *
 * @evolution Transport-INDEPENDENT: it tracks an abstract group-operation reliability record + reacts
 * via INJECTED recovery hooks (resume / retry / replan). It builds on the FROZEN Sprint-1/2 interfaces
 * without modifying them. Layer 10 Sprint 4 (Group Delivery & Read Receipt Engine) builds on the frozen
 * interfaces + events here. It does NOT implement read receipts, delivery aggregation, per-member
 * delivery tracking, blue-tick logic, or voice/video.
 */

// === the group operations this layer makes reliable =======================

/**
 * The kind of group-communication operation a reliability record tracks. @readonly @enum {string}
 */
export const GroupOperationType = Object.freeze({
  GROUP_MESSAGE: "group-message", // a message being fanned out to the group
  FAN_OUT: "fan-out", // an explicit fan-out plan execution
  MEMBERSHIP_UPDATE: "membership-update", // a membership change propagating
  REKEY: "rekey", // a group-key rotation + redistribution
  REPLICA_SYNC: "replica-sync", // a group synchronization / replica catch-up
  OFFLINE_DELIVERY: "offline-delivery", // deferred delivery to a reconnecting member
});

export const ALL_OPERATION_TYPES = Object.freeze(Object.values(GroupOperationType));

// === reliability lifecycle ================================================

/**
 * The reliability layer's view of a group operation's health/continuity state (a validated FSM — see
 * {@link module:group-reliability/manager}). Distinct from the Sprint-2 delivery/fan-out states; this
 * tracks reliability, not the operation's own progress.
 * @readonly @enum {string}
 */
export const ReliabilityState = Object.freeze({
  TRACKING: "tracking", // registered + progressing healthily
  DEGRADED: "degraded", // progressing but unhealthy (high failure rate / low throughput / backlog)
  INTERRUPTED: "interrupted", // stalled / failed mid-operation — awaiting recovery
  RECOVERING: "recovering", // running a recovery plan (resume from checkpoint)
  COMPLETED: "completed", // the operation finished successfully (terminal)
  FAILED: "failed", // recovery exhausted / unrecoverable (terminal)
  ABANDONED: "abandoned", // cancelled / expired by the owner (terminal)
});

export const ALL_RELIABILITY_STATES = Object.freeze(Object.values(ReliabilityState));

/** States in which the operation is still being tracked / worked. */
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

/** What interrupted a group operation / triggered a recovery. @readonly @enum {string} */
export const RecoveryTrigger = Object.freeze({
  INTERRUPTED_MESSAGING: "interrupted-messaging", // a group message send was interrupted
  FAILED_FANOUT: "failed-fanout", // fan-out legs failed
  MEMBERSHIP_FAILURE: "membership-failure", // a membership update failed to propagate
  REKEY_FAILURE: "rekey-failure", // a key rotation / redistribution failed
  REPLICA_FAILURE: "replica-failure", // a replica update failed
  SYNC_FAILURE: "sync-failure", // a group synchronization failed
  OFFLINE_INTERRUPTION: "offline-interruption", // a deferred delivery was interrupted
  CONNECTION_LOSS: "connection-loss", // the connection dropped
  STALL_TIMEOUT: "stall-timeout", // no progress for too long
  REPOSITORY_FAILURE: "repository-failure", // a storage failure
});

export const ALL_RECOVERY_TRIGGERS = Object.freeze(Object.values(RecoveryTrigger));

/**
 * The action a recovery performs. All PRESERVE consistency (resume from the checkpoint; never silently
 * drop completed targets). @readonly @enum {string}
 */
export const RecoveryAction = Object.freeze({
  RESUME_FROM_CHECKPOINT: "resume-from-checkpoint", // re-run only the remaining targets/legs
  RETRY: "retry", // retry the current step
  REPLAN: "replan", // re-plan the fan-out / sync (recomputed; still consistent)
  GRACEFUL_FAIL: "graceful-fail", // give up cleanly (recovery exhausted) — checkpoint intact
});

/** Which action + recoverability each trigger defaults to. */
export const RECOVERY_PLANS = Object.freeze({
  [RecoveryTrigger.INTERRUPTED_MESSAGING]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.FAILED_FANOUT]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.MEMBERSHIP_FAILURE]: { action: RecoveryAction.REPLAN, recoverable: true },
  [RecoveryTrigger.REKEY_FAILURE]: { action: RecoveryAction.RETRY, recoverable: true },
  [RecoveryTrigger.REPLICA_FAILURE]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.SYNC_FAILURE]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.OFFLINE_INTERRUPTION]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.CONNECTION_LOSS]: { action: RecoveryAction.RETRY, recoverable: true },
  [RecoveryTrigger.STALL_TIMEOUT]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.REPOSITORY_FAILURE]: { action: RecoveryAction.REPLAN, recoverable: true },
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
  retryBudget: 25, // total retries allowed across a record's life
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: true,
  cooldownMs: 1_000,
  recoveryTimeoutMs: 120_000,
  autoResume: true,
});

// === health ===============================================================

/** Group-operation health status. @readonly @enum {string} */
export const HealthStatus = Object.freeze({ HEALTHY: "healthy", DEGRADED: "degraded", UNHEALTHY: "unhealthy", UNKNOWN: "unknown" });

/** Health-score dimension weights (sum → 1). Higher score = healthier. */
export const HEALTH_WEIGHTS = Object.freeze({ progress: 0.3, reliability: 0.3, backlog: 0.2, freshness: 0.2 });

/** Failure rate (failed targets per attempted) at/above which the reliability dimension scores 0. */
export const FAILURE_RATE_CEILING = 0.5;
/** Pending/backlog targets at/above which the backlog dimension scores 0. */
export const BACKLOG_CEILING = 1_000;
/** Staleness (ms since last activity) at/above which the freshness dimension scores 0. */
export const STALENESS_CEILING_MS = 60_000;

// === observability ========================================================

export const MetricType = Object.freeze({ COUNTER: "counter", GAUGE: "gauge", HISTOGRAM: "histogram" });

/** Canonical group-reliability metric names (stable — frozen interface). */
export const Metric = Object.freeze({
  OPERATION_TOTAL: "group_operation_total",
  OPERATION_SUCCESS: "group_operation_success_total",
  OPERATION_FAILURE: "group_operation_failure_total",
  MESSAGES_PER_GROUP: "group_messages_total",
  FANOUT_LATENCY: "group_fanout_latency_ms",
  FANOUT_TARGETS: "group_fanout_targets",
  GROUP_THROUGHPUT: "group_throughput_ops_per_sec",
  REPLICA_DRIFT: "group_replica_drift",
  SYNC_LATENCY: "group_sync_latency_ms",
  MEMBERSHIP_CHANGES: "group_membership_changes_total",
  KEY_ROTATION_TOTAL: "group_key_rotation_total",
  OFFLINE_QUEUE_SIZE: "group_offline_queue_size",
  PENDING_OPERATIONS: "group_pending_operations",
  RECOVERY_TOTAL: "group_recovery_total",
  RECOVERY_SUCCESS: "group_recovery_success_total",
  RECOVERY_FAILURE: "group_recovery_failure_total",
  RECOVERY_TIME: "group_recovery_time_ms",
  RESUME_TOTAL: "group_resume_total",
  RETRY_TOTAL: "group_retry_total",
  CONCURRENT_OPERATIONS: "group_concurrent_operations",
  HEALTH_SCORE: "group_health_score",
  ALERT_TOTAL: "group_alert_total",
});

/** Reliability event types (a FUTURE Sprint 4 consumes these). @readonly @enum {string} */
export const ReliabilityEventType = Object.freeze({
  OPERATION_REGISTERED: "group-reliability.registered",
  CHECKPOINT_RECORDED: "group-reliability.checkpoint_recorded",
  STATE_CHANGED: "group-reliability.state_changed",
  HEALTH_CHANGED: "group-reliability.health_changed",
  OPERATION_INTERRUPTED: "group-reliability.interrupted",
  RECOVERY_STARTED: "group-reliability.recovery_started",
  RECOVERY_SUCCEEDED: "group-reliability.recovery_succeeded",
  RECOVERY_FAILED: "group-reliability.recovery_failed",
  OPERATION_RESUMED: "group-reliability.resumed",
  BACKLOG_DETECTED: "group-reliability.backlog_detected",
  OPERATION_COMPLETED: "group-reliability.completed",
  OPERATION_FAILED: "group-reliability.failed",
  ALERT_RAISED: "group-reliability.alert_raised",
});

/** Alert types the {@link module:group-reliability/monitoring monitor} raises. */
export const AlertType = Object.freeze({
  OPERATION_FAILURE_SPIKE: "operation-failure-spike",
  REPEATED_RECOVERY_FAILURE: "repeated-recovery-failure",
  UNHEALTHY_GROUP: "unhealthy-group",
  STALL_TIMEOUT: "stall-timeout",
  HIGH_FANOUT_FAILURE: "high-fanout-failure",
  HIGH_REPLICA_DRIFT: "high-replica-drift",
  LARGE_OFFLINE_BACKLOG: "large-offline-backlog",
  RETRY_STORM: "retry-storm",
});

export const AlertSeverity = Object.freeze({ INFO: "info", WARNING: "warning", CRITICAL: "critical" });

/** Machine-readable failure/validation reasons. */
export const ReliabilityFailureReason = Object.freeze({
  UNKNOWN_OPERATION: "unknown-operation",
  INVALID_TRANSITION: "invalid-transition",
  RECOVERY_EXHAUSTED: "recovery-exhausted",
  UNRECOVERABLE: "unrecoverable",
  MALFORMED_RECORD: "malformed-record",
  UNAUTHORIZED: "unauthorized",
  RETRY_BUDGET_EXCEEDED: "retry-budget-exceeded",
  INTERNAL_ERROR: "internal-error",
});

// === constants ============================================================

export const GROUPREL_FRAMEWORK = "group-reliability";
export const GROUPREL_SCHEMA_VERSION = 1;

/** The frozen Layer-10 group-communication platform version (bump = breaking change). */
export const GROUP_LAYER_VERSION = "1.0";

/** Default stall timeout (ms): no progress this long → the operation is considered interrupted. */
export const DEFAULT_STALL_TIMEOUT_MS = 45_000;

/** Default reliability record TTL (ms) before an inactive record expires (offline members may be away). */
export const DEFAULT_OPERATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Default monitor window (ms) + alert thresholds per window. */
export const DEFAULT_MONITOR_WINDOW_MS = 60_000;
export const DEFAULT_ALERT_THRESHOLDS = Object.freeze({
  [AlertType.OPERATION_FAILURE_SPIKE]: 10,
  [AlertType.REPEATED_RECOVERY_FAILURE]: 3,
  [AlertType.UNHEALTHY_GROUP]: 1,
  [AlertType.STALL_TIMEOUT]: 5,
  [AlertType.HIGH_FANOUT_FAILURE]: 1,
  [AlertType.HIGH_REPLICA_DRIFT]: 1,
  [AlertType.LARGE_OFFLINE_BACKLOG]: 1,
  [AlertType.RETRY_STORM]: 100,
});

/** Backlog (pending targets / offline queue) at/above which a backlog signal fires. */
export const BACKLOG_SIGNAL_THRESHOLD = 500;

/** Pagination bounds (API hardening). */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * @typedef {object} GroupReliabilityRecord The reliability layer's view of a group operation. CONTROL-
 *   PLANE metadata only — no content, no keys.
 * @property {string} operationId @property {string} groupId @property {string} operationType one of {@link GroupOperationType}
 * @property {string} deviceId @property {string} userId @property {string} state one of {@link ReliabilityState}
 * @property {object} checkpoint {@link GroupCheckpoint} @property {object} health {@link GroupHealth}
 * @property {number|null} keyVersion @property {number} recoveryCount @property {number} resumeCount @property {number} retryCount
 * @property {object} retryPolicy @property {object} metadata
 * @property {string} registeredAt @property {string} updatedAt @property {string} lastActivityAt @property {string} expiresAt
 * @property {number} version @property {number} schemaVersion
 */

/**
 * @typedef {object} GroupCheckpoint The resumable progress of a group operation. Counts only — no content.
 * @property {number} totalTargets fan-out legs / sync ops / rekey distributions @property {number} completedTargets
 * @property {number} cursor resume cursor @property {number} failedTargets @property {number} pendingTargets
 * @property {number} retriedTargets @property {number} drift replica drift / offline backlog @property {string} checkpointAt
 */

/**
 * @typedef {object} GroupHealth
 * @property {string} status one of {@link HealthStatus} @property {number} score `[0,1]`
 * @property {number} progress @property {number} failureRate @property {number} pending
 * @property {number} stalenessMs @property {number} throughput
 */

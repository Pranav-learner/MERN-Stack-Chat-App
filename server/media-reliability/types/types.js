/**
 * @module media-reliability/types
 *
 * Enums + constants for the **Media Reliability & Production Hardening** subsystem — Layer 11, Sprint 3,
 * the capstone that makes the Secure Media Platform (Media Pipeline Sprint 1 + Media Delivery Engine
 * Sprint 2) production-grade. It does NOT upload, download, stream, or store media itself: it makes those
 * MEDIA OPERATIONS *reliable* — interrupted-upload / interrupted-download / streaming / pipeline / storage
 * / synchronization recovery, continuous health monitoring, configurable retry policies, observability
 * (metrics + Prometheus/OTel hooks), a hot-metadata cache with hit-rate observability, security
 * validation, and a protocol freeze.
 *
 * @security This subsystem operates on media CONTROL-PLANE metadata + numeric aggregates ONLY — media
 * ids, operation ids, chunk/byte counts, hashes-as-integrity-flags, health scores, recovery reasons. It
 * NEVER handles media plaintext, ciphertext bytes, or key material. Recovery PRESERVES integrity +
 * metadata consistency (the monotonic operation checkpoint) so a resume re-transfers only the remaining
 * chunks; it never corrupts media state.
 *
 * @evolution Storage-provider-INDEPENDENT: it tracks an abstract media-operation reliability record +
 * reacts via INJECTED recovery hooks (resume / retry / replan). It builds on the FROZEN Sprint-1/2
 * interfaces without modifying them. Layer 12 (Distributed Hybrid Architecture) builds on the frozen
 * interfaces + events here. It does NOT implement voice/video calls, screen sharing, real-time media, or
 * codecs.
 */

// === the media operations this layer makes reliable =======================

/** The kind of media operation a reliability record tracks. @readonly @enum {string} */
export const MediaOperationType = Object.freeze({
  UPLOAD: "upload", // an encrypted media upload (whole or progressive)
  DOWNLOAD: "download", // an encrypted media download (whole or progressive)
  STREAMING: "streaming", // a streaming session
  SYNCHRONIZATION: "synchronization", // a multi-device media sync
  PIPELINE: "pipeline", // a pipeline stage (store/verify) — storage-facing
});

export const ALL_OPERATION_TYPES = Object.freeze(Object.values(MediaOperationType));

// === reliability lifecycle ================================================

/**
 * The reliability layer's view of a media operation's health/continuity state (a validated FSM — see
 * {@link module:media-reliability/manager}). Distinct from the Sprint-1/2 operation states; this tracks
 * reliability, not the operation's own progress.
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

/** What interrupted a media operation / triggered a recovery. @readonly @enum {string} */
export const RecoveryTrigger = Object.freeze({
  INTERRUPTED_UPLOAD: "interrupted-upload", // an upload was interrupted mid-transfer
  INTERRUPTED_DOWNLOAD: "interrupted-download", // a download was interrupted mid-transfer
  STREAMING_FAILURE: "streaming-failure", // a streaming session failed / stalled
  PIPELINE_FAILURE: "pipeline-failure", // a pipeline stage (store/verify) failed
  STORAGE_FAILURE: "storage-failure", // the storage provider errored
  SYNC_FAILURE: "sync-failure", // a media synchronization failed
  CONNECTION_LOSS: "connection-loss", // the connection dropped
  STALL_TIMEOUT: "stall-timeout", // no progress for too long
});

export const ALL_RECOVERY_TRIGGERS = Object.freeze(Object.values(RecoveryTrigger));

/**
 * The action a recovery performs. All PRESERVE integrity + metadata consistency (resume from the
 * checkpoint; never silently drop completed chunks). @readonly @enum {string}
 */
export const RecoveryAction = Object.freeze({
  RESUME_FROM_CHECKPOINT: "resume-from-checkpoint", // re-transfer only the remaining chunks
  RETRY: "retry", // retry the current step (storage/connection blip)
  REPLAN: "replan", // re-run the pipeline stage (recomputed; still consistent)
  GRACEFUL_FAIL: "graceful-fail", // give up cleanly (recovery exhausted) — checkpoint intact
});

/** Which action + recoverability each trigger defaults to. */
export const RECOVERY_PLANS = Object.freeze({
  [RecoveryTrigger.INTERRUPTED_UPLOAD]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.INTERRUPTED_DOWNLOAD]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.STREAMING_FAILURE]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.PIPELINE_FAILURE]: { action: RecoveryAction.REPLAN, recoverable: true },
  [RecoveryTrigger.STORAGE_FAILURE]: { action: RecoveryAction.RETRY, recoverable: true },
  [RecoveryTrigger.SYNC_FAILURE]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
  [RecoveryTrigger.CONNECTION_LOSS]: { action: RecoveryAction.RETRY, recoverable: true },
  [RecoveryTrigger.STALL_TIMEOUT]: { action: RecoveryAction.RESUME_FROM_CHECKPOINT, recoverable: true },
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

/** Media-operation health status. @readonly @enum {string} */
export const HealthStatus = Object.freeze({ HEALTHY: "healthy", DEGRADED: "degraded", UNHEALTHY: "unhealthy", UNKNOWN: "unknown" });

/** Health-score dimension weights (sum → 1). Higher score = healthier. */
export const HEALTH_WEIGHTS = Object.freeze({ progress: 0.3, reliability: 0.3, backlog: 0.2, freshness: 0.2 });

/** Failure rate (failed chunks per attempted) at/above which the reliability dimension scores 0. */
export const FAILURE_RATE_CEILING = 0.5;
/** Pending/backlog chunks at/above which the backlog dimension scores 0. */
export const BACKLOG_CEILING = 100_000; // chunks (10GB+ / 256KB ≈ 40k chunks)
/** Staleness (ms since last activity) at/above which the freshness dimension scores 0. */
export const STALENESS_CEILING_MS = 60_000;

// === observability ========================================================

export const MetricType = Object.freeze({ COUNTER: "counter", GAUGE: "gauge", HISTOGRAM: "histogram" });

/** Canonical media-reliability metric names (stable — frozen interface). */
export const Metric = Object.freeze({
  OPERATION_TOTAL: "media_operation_total",
  OPERATION_SUCCESS: "media_operation_success_total",
  OPERATION_FAILURE: "media_operation_failure_total",
  UPLOAD_TOTAL: "media_upload_total",
  UPLOAD_SUCCESS: "media_upload_success_total",
  UPLOAD_FAILURE: "media_upload_failure_total",
  UPLOAD_TIME: "media_upload_time_ms",
  UPLOAD_THROUGHPUT: "media_upload_throughput_bytes_per_sec",
  DOWNLOAD_TOTAL: "media_download_total",
  DOWNLOAD_SUCCESS: "media_download_success_total",
  DOWNLOAD_FAILURE: "media_download_failure_total",
  DOWNLOAD_TIME: "media_download_time_ms",
  DOWNLOAD_THROUGHPUT: "media_download_throughput_bytes_per_sec",
  STREAMING_TOTAL: "media_streaming_total",
  STREAMING_THROUGHPUT: "media_streaming_throughput_bytes_per_sec",
  BYTES_TRANSFERRED: "media_bytes_transferred_total",
  SYNC_LATENCY: "media_sync_latency_ms",
  STORAGE_ERRORS: "media_storage_errors_total",
  RECOVERY_TOTAL: "media_recovery_total",
  RECOVERY_SUCCESS: "media_recovery_success_total",
  RECOVERY_FAILURE: "media_recovery_failure_total",
  RECOVERY_TIME: "media_recovery_time_ms",
  RESUME_TOTAL: "media_resume_total",
  RETRY_TOTAL: "media_retry_total",
  CACHE_HIT: "media_cache_hit_total",
  CACHE_MISS: "media_cache_miss_total",
  PENDING_CHUNKS: "media_pending_chunks",
  CONCURRENT_OPERATIONS: "media_concurrent_operations",
  HEALTH_SCORE: "media_health_score",
  ALERT_TOTAL: "media_alert_total",
});

/** Reliability event types (a FUTURE Layer 12 consumes these). @readonly @enum {string} */
export const ReliabilityEventType = Object.freeze({
  OPERATION_REGISTERED: "media-reliability.registered",
  CHECKPOINT_RECORDED: "media-reliability.checkpoint_recorded",
  STATE_CHANGED: "media-reliability.state_changed",
  HEALTH_CHANGED: "media-reliability.health_changed",
  OPERATION_INTERRUPTED: "media-reliability.interrupted",
  RECOVERY_STARTED: "media-reliability.recovery_started",
  RECOVERY_SUCCEEDED: "media-reliability.recovery_succeeded",
  RECOVERY_FAILED: "media-reliability.recovery_failed",
  OPERATION_RESUMED: "media-reliability.resumed",
  BACKLOG_DETECTED: "media-reliability.backlog_detected",
  OPERATION_COMPLETED: "media-reliability.completed",
  OPERATION_FAILED: "media-reliability.failed",
  ALERT_RAISED: "media-reliability.alert_raised",
});

/** Alert types the {@link module:media-reliability/monitoring monitor} raises. */
export const AlertType = Object.freeze({
  OPERATION_FAILURE_SPIKE: "operation-failure-spike",
  REPEATED_RECOVERY_FAILURE: "repeated-recovery-failure",
  UNHEALTHY_MEDIA: "unhealthy-media",
  STALL_TIMEOUT: "stall-timeout",
  HIGH_TRANSFER_FAILURE: "high-transfer-failure",
  STORAGE_FAILURE_SPIKE: "storage-failure-spike",
  LARGE_BACKLOG: "large-backlog",
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

export const MEDIAREL_FRAMEWORK = "media-reliability";
export const MEDIAREL_SCHEMA_VERSION = 1;

/** The frozen Layer-11 Secure Media Platform version (bump = breaking change). */
export const MEDIA_LAYER_VERSION = "1.0";

/** Default stall timeout (ms): no progress this long → the operation is considered interrupted. */
export const DEFAULT_STALL_TIMEOUT_MS = 60_000; // media transfers can be slow; be generous

/** Default reliability record TTL (ms) before an inactive record expires (a large upload may pause). */
export const DEFAULT_OPERATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Default monitor window (ms) + alert thresholds per window. */
export const DEFAULT_MONITOR_WINDOW_MS = 60_000;
export const DEFAULT_ALERT_THRESHOLDS = Object.freeze({
  [AlertType.OPERATION_FAILURE_SPIKE]: 10,
  [AlertType.REPEATED_RECOVERY_FAILURE]: 3,
  [AlertType.UNHEALTHY_MEDIA]: 1,
  [AlertType.STALL_TIMEOUT]: 5,
  [AlertType.HIGH_TRANSFER_FAILURE]: 1,
  [AlertType.STORAGE_FAILURE_SPIKE]: 5,
  [AlertType.LARGE_BACKLOG]: 1,
  [AlertType.RETRY_STORM]: 100,
});

/** Backlog (pending chunks) at/above which a backlog signal fires. */
export const BACKLOG_SIGNAL_THRESHOLD = 20_000;

/** Default hot-metadata cache TTL (ms) + size. */
export const DEFAULT_CACHE_TTL_MS = 60_000;
export const DEFAULT_CACHE_MAX = 20_000;

/** Pagination bounds (API hardening). */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * @typedef {object} MediaReliabilityRecord The reliability layer's view of a media operation. CONTROL-
 *   PLANE metadata only — no content, no keys.
 * @property {string} operationId @property {string} mediaId @property {string} operationType one of {@link MediaOperationType}
 * @property {string} deviceId @property {string} userId @property {string} state one of {@link ReliabilityState}
 * @property {object} checkpoint {@link MediaCheckpoint} @property {object} health {@link MediaHealth}
 * @property {string|null} storageProvider @property {number} recoveryCount @property {number} resumeCount @property {number} retryCount
 * @property {object} retryPolicy @property {object} metadata
 * @property {string} registeredAt @property {string} updatedAt @property {string} lastActivityAt @property {string} expiresAt
 * @property {number} version @property {number} schemaVersion
 */

/**
 * @typedef {object} MediaCheckpoint The resumable progress of a media operation. Counts only — no content.
 * @property {number} totalChunks @property {number} completedChunks @property {number} cursor resume cursor
 * @property {number} failedChunks @property {number} pendingChunks @property {number} retriedChunks
 * @property {number} bytesTotal @property {number} bytesTransferred @property {string} checkpointAt
 */

/**
 * @typedef {object} MediaHealth
 * @property {string} status one of {@link HealthStatus} @property {number} score `[0,1]`
 * @property {number} progress @property {number} failureRate @property {number} pending
 * @property {number} stalenessMs @property {number} throughput
 */

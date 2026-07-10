/**
 * @module crypto-hardening/types
 *
 * Enums and type declarations for the **Production Cryptographic Hardening** subsystem
 * (Layer 5, Sprint 6). This sprint introduces **no new cryptography**. It adds the
 * cross-cutting production concerns that make the Layer 2–5 crypto pipeline production-ready:
 * replay protection, key-lifecycle verification, failure recovery, observability, security
 * monitoring, and a protocol freeze.
 *
 * @security Everything here operates on PUBLIC metadata (session ids, generations, message
 * numbers, key ids, fingerprints, nonces, timestamps) — it never touches key bytes. It is
 * additive defence-in-depth around the existing, unchanged crypto layers.
 */

/** Result reasons from the replay guard. @readonly @enum {string} */
export const ReplayVerdict = Object.freeze({
  OK: "ok",
  DUPLICATE_MESSAGE: "duplicate-message",
  DUPLICATE_NONCE: "duplicate-nonce",
  GENERATION_ROLLBACK: "generation-rollback",
  OUT_OF_WINDOW: "out-of-window",
  MALFORMED: "malformed",
});

/** Metric kinds. @readonly @enum {string} */
export const MetricType = Object.freeze({
  COUNTER: "counter",
  GAUGE: "gauge",
  HISTOGRAM: "histogram",
});

/** Security alert types. @readonly @enum {string} */
export const AlertType = Object.freeze({
  SUSPICIOUS_REPLAY: "suspicious-replay",
  REPEATED_VALIDATION_FAILURE: "repeated-validation-failure",
  GENERATION_ROLLBACK_ATTEMPT: "generation-rollback-attempt",
  REPEATED_HANDSHAKE_FAILURE: "repeated-handshake-failure",
  KEY_LIFECYCLE_ANOMALY: "key-lifecycle-anomaly",
  REPOSITORY_INCONSISTENCY: "repository-inconsistency",
  METADATA_CORRUPTION: "metadata-corruption",
});

/** Alert severities. @readonly @enum {string} */
export const AlertSeverity = Object.freeze({
  INFO: "info",
  WARNING: "warning",
  CRITICAL: "critical",
});

/** Failure kinds the recovery coordinator handles. @readonly @enum {string} */
export const RecoveryKind = Object.freeze({
  INTERRUPTED_ENCRYPTION: "interrupted-encryption",
  INTERRUPTED_DECRYPTION: "interrupted-decryption",
  CORRUPTED_METADATA: "corrupted-metadata",
  SESSION_MISMATCH: "session-mismatch",
  CHAIN_MISMATCH: "chain-mismatch",
  GENERATION_MISMATCH: "generation-mismatch",
  REPOSITORY_CORRUPTION: "repository-corruption",
});

/** Recovery actions. @readonly @enum {string} */
export const RecoveryAction = Object.freeze({
  CLEANUP_AND_RETRY: "cleanup-and-retry",
  DROP_MESSAGE: "drop-message",
  RESET_REPLAY_WINDOW: "reset-replay-window",
  QUARANTINE_RECORD: "quarantine-record",
  REDERIVE: "re-derive",
  ESCALATE: "escalate",
});

/** Hardening event types. @readonly @enum {string} */
export const HardeningEventType = Object.freeze({
  REPLAY_DETECTED: "hardening.replay_detected",
  REPLAY_ACCEPTED: "hardening.replay_accepted",
  REPLAY_WINDOW_RESET: "hardening.replay_window_reset",
  LIFECYCLE_VERIFIED: "hardening.lifecycle_verified",
  LIFECYCLE_VIOLATION: "hardening.lifecycle_violation",
  RECOVERY_STARTED: "hardening.recovery_started",
  RECOVERY_COMPLETED: "hardening.recovery_completed",
  ALERT_RAISED: "hardening.alert_raised",
});

/** Lifecycle phases a key passes through (for verification). @readonly @enum {string} */
export const KeyPhase = Object.freeze({
  CREATED: "created",
  ACTIVATED: "activated",
  USED: "used",
  ROTATED: "rotated",
  DESTROYED: "destroyed",
});

/** Default replay sliding-window size (messages tracked per session/generation). */
export const DEFAULT_REPLAY_WINDOW = 2048;
/** Default TTL for a replay-cache entry (ms). */
export const DEFAULT_REPLAY_TTL_MS = 60 * 60 * 1000; // 1h
/** Default nonce-cache size per session. */
export const DEFAULT_NONCE_CACHE = 4096;
/** Default window (ms) over which security-monitor anomaly counts accumulate. */
export const DEFAULT_MONITOR_WINDOW_MS = 60 * 1000; // 1m
/** Default replay-detection count within the window that raises a suspicious-replay alert. */
export const DEFAULT_REPLAY_ALERT_THRESHOLD = 5;
/** Default repeated-validation-failure count that raises an alert. */
export const DEFAULT_VALIDATION_FAILURE_THRESHOLD = 10;
/** Current hardening-metadata storage schema version. */
export const HARDENING_SCHEMA_VERSION = 1;

/**
 * @typedef {object} ReplayContext
 * @property {string} sessionId @property {number} generation @property {number} messageNumber
 * @property {string} [nonce] a per-message unique value (secure-transport metadata nonce)
 */

/**
 * @typedef {object} SecurityAlert
 * @property {string} alertId @property {string} type one of {@link AlertType}
 * @property {string} severity one of {@link AlertSeverity} @property {string} [sessionId]
 * @property {string} message @property {object} [details] @property {string} at ISO
 */

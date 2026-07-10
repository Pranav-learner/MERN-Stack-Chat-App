/**
 * @module shs/hardening/types
 *
 * Enums and type declarations for the Secure Handshake **Hardening** subsystem
 * (Layer 4, Sprint 4). This subsystem adds production resilience — replay/downgrade
 * protection, protocol integrity, recovery, continuous session validation,
 * observability, and repository hardening — WITHOUT changing the Sprint 1–3 protocol.
 *
 * @security Everything here operates on PUBLIC protocol metadata (ids, versions,
 * nonces, states, timings). No private keys, shared secrets, or session keys are
 * accessed. Hardening is additive: it composes with the existing managers.
 */

/** Reasons a message/handshake is rejected as a replay. @readonly @enum {string} */
export const ReplayReason = Object.freeze({
  DUPLICATE_NONCE: "duplicate-nonce",
  DUPLICATE_MESSAGE_ID: "duplicate-message-id",
  DUPLICATE_HANDSHAKE: "duplicate-handshake",
  STALE_TIMESTAMP: "stale-timestamp",
  FUTURE_TIMESTAMP: "future-timestamp",
});

/** Reasons a negotiation is rejected as a downgrade attack. @readonly @enum {string} */
export const DowngradeReason = Object.freeze({
  BELOW_MINIMUM_VERSION: "below-minimum-version",
  INSECURE_VERSION: "insecure-version",
  NOT_MAX_COMMON_VERSION: "not-max-common-version",
  CAPABILITY_STRIPPED: "capability-stripped",
  ALGORITHM_STRIPPED: "algorithm-stripped",
  TRANSCRIPT_MISMATCH: "transcript-mismatch",
});

/** Reasons a protocol-integrity check fails. @readonly @enum {string} */
export const IntegrityReason = Object.freeze({
  BAD_HEADER: "bad-header",
  BAD_METADATA: "bad-metadata",
  OUT_OF_ORDER: "out-of-order",
  UNEXPECTED_MESSAGE: "unexpected-message",
  STATE_INCONSISTENT: "state-inconsistent",
  MALFORMED_PAYLOAD: "malformed-payload",
  CORRUPTED_SERIALIZATION: "corrupted-serialization",
  UNEXPECTED_TRANSITION: "unexpected-transition",
});

/** Recovery decisions for an interrupted/failed handshake. @readonly @enum {string} */
export const RecoveryAction = Object.freeze({
  RESUME: "resume", // recover an interrupted handshake in place
  RETRY: "retry", // restart with backoff
  WAIT: "wait", // transient — back off and try again later
  ABORT: "abort", // unrecoverable — give up
});

/** Classification of a failure for recovery purposes. @readonly @enum {string} */
export const FailureClass = Object.freeze({
  TRANSIENT: "transient", // network blip, timeout — retry/wait
  RECOVERABLE: "recoverable", // interrupted but resumable
  PERMANENT: "permanent", // protocol/validation/auth — abort
});

/** Protocol health levels. @readonly @enum {string} */
export const HealthStatus = Object.freeze({
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  UNHEALTHY: "unhealthy",
});

/** Hardening event types (emitted on the hardening event bus). @readonly @enum {string} */
export const HardeningEventType = Object.freeze({
  REPLAY_DETECTED: "hardening.replay_detected",
  DOWNGRADE_BLOCKED: "hardening.downgrade_blocked",
  INTEGRITY_VIOLATION: "hardening.integrity_violation",
  RECOVERY_ATTEMPTED: "hardening.recovery_attempted",
  RECOVERY_SUCCEEDED: "hardening.recovery_succeeded",
  RECOVERY_ABORTED: "hardening.recovery_aborted",
  SESSION_GUARD_FAILED: "hardening.session_guard_failed",
  REPLAY_CACHE_EVICTED: "hardening.replay_cache_evicted",
});

/**
 * @typedef {object} ReplayVerdict
 * @property {boolean} ok whether the message passed replay checks
 * @property {string} [reason] one of {@link ReplayReason} if rejected
 * @property {object} [details]
 */

/**
 * @typedef {object} DowngradeVerdict
 * @property {boolean} ok
 * @property {string} [reason] one of {@link DowngradeReason}
 * @property {string} [expectedVersion] @property {string} [negotiatedVersion]
 * @property {string[]} [strippedCapabilities]
 */

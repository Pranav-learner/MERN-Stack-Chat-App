/**
 * @module fabric-reliability/errors
 *
 * Typed error hierarchy for the **Production Communication Fabric** reliability layer (Layer 12, Sprint 4).
 * Every error carries a stable `.code`, an HTTP `.status`, a machine-readable `.reason` from
 * {@link ReliabilityFailureReason}, and a `.failureClass` so the retry/circuit/recovery machinery can react
 * uniformly. Mirrors the frozen lower layers.
 *
 * @security Errors carry ids + classifications + the offending (validated-safe) metadata only — never
 * content/keys.
 */

import { ReliabilityFailureReason, FailureClass } from "./types/types.js";

export class ReliabilityError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_RELIABILITY";
    this.status = options.status ?? 500;
    this.reason = options.reason ?? ReliabilityFailureReason.INTERNAL_ERROR;
    this.failureClass = options.failureClass ?? FailureClass.UNKNOWN;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** The circuit breaker is open — the call was rejected fast. */
export class CircuitOpenError extends ReliabilityError {
  constructor(message = "Circuit breaker is open", options = {}) {
    super(message, { code: "ERR_RELIABILITY_CIRCUIT_OPEN", status: 503, reason: ReliabilityFailureReason.CIRCUIT_OPEN, failureClass: FailureClass.RESOURCE, ...options });
  }
}

/** The bulkhead compartment is saturated (concurrency + queue full). */
export class BulkheadFullError extends ReliabilityError {
  constructor(message = "Bulkhead compartment is full", options = {}) {
    super(message, { code: "ERR_RELIABILITY_BULKHEAD_FULL", status: 503, reason: ReliabilityFailureReason.BULKHEAD_FULL, failureClass: FailureClass.RESOURCE, ...options });
  }
}

/** The operation exceeded its deadline. */
export class OperationTimeoutError extends ReliabilityError {
  constructor(message = "Operation timed out", options = {}) {
    super(message, { code: "ERR_RELIABILITY_TIMEOUT", status: 504, reason: ReliabilityFailureReason.TIMEOUT, failureClass: FailureClass.TIMEOUT, ...options });
  }
}

/** Retries were exhausted. */
export class RetryExhaustedError extends ReliabilityError {
  constructor(message = "Retry attempts exhausted", options = {}) {
    super(message, { code: "ERR_RELIABILITY_RETRY_EXHAUSTED", status: 503, reason: ReliabilityFailureReason.RETRY_EXHAUSTED, failureClass: FailureClass.TRANSIENT, ...options });
  }
}

/** Recovery failed / the operation was abandoned. */
export class RecoveryFailedError extends ReliabilityError {
  constructor(message = "Recovery failed", options = {}) {
    super(message, { code: "ERR_RELIABILITY_RECOVERY_FAILED", status: 500, reason: ReliabilityFailureReason.RECOVERY_FAILED, failureClass: FailureClass.PERMANENT, ...options });
  }
}

/** The caller is not authorized for the operation. */
export class UnauthorizedReliabilityError extends ReliabilityError {
  constructor(message = "Unauthorized operation", options = {}) {
    super(message, { code: "ERR_RELIABILITY_UNAUTHORIZED", status: 403, reason: ReliabilityFailureReason.UNAUTHORIZED, failureClass: FailureClass.AUTHORIZATION, ...options });
  }
}

/** A replayed operation was detected (idempotency / replay protection). */
export class ReplayDetectedError extends ReliabilityError {
  constructor(message = "Replay detected", options = {}) {
    super(message, { code: "ERR_RELIABILITY_REPLAY", status: 409, reason: ReliabilityFailureReason.REPLAY_DETECTED, failureClass: FailureClass.VALIDATION, ...options });
  }
}

/** The caller exceeded a rate limit. */
export class RateLimitedError extends ReliabilityError {
  constructor(message = "Rate limit exceeded", options = {}) {
    super(message, { code: "ERR_RELIABILITY_RATE_LIMITED", status: 429, reason: ReliabilityFailureReason.RATE_LIMITED, failureClass: FailureClass.RESOURCE, ...options });
  }
}

/** A malformed / unknown operation reached the reliability layer. */
export class InvalidOperationError extends ReliabilityError {
  constructor(message = "Invalid operation", options = {}) {
    super(message, { code: "ERR_RELIABILITY_INVALID_OP", status: 400, reason: ReliabilityFailureReason.INVALID_OPERATION, failureClass: FailureClass.VALIDATION, ...options });
  }
}

/** A repository violated its contract. */
export class ReliabilityRepositoryError extends ReliabilityError {
  constructor(message = "Reliability repository inconsistency", options = {}) {
    super(message, { code: "ERR_RELIABILITY_REPO", status: 500, reason: ReliabilityFailureReason.REPOSITORY_INCONSISTENT, failureClass: FailureClass.PERMANENT, ...options });
  }
}

/** The reliability layer was configured incorrectly. */
export class ReliabilityConfigurationError extends ReliabilityError {
  constructor(message = "Reliability configuration error", options = {}) {
    super(message, { code: "ERR_RELIABILITY_CONFIG", status: 500, reason: ReliabilityFailureReason.CONFIGURATION_ERROR, failureClass: FailureClass.PERMANENT, ...options });
  }
}

/** Content / key material detected in a control-plane record. */
export class ReliabilityContentLeakError extends ReliabilityError {
  constructor(message = "Content/key material detected in a reliability record", options = {}) {
    super(message, { code: "ERR_RELIABILITY_CONTENT_LEAK", status: 500, reason: ReliabilityFailureReason.CONTENT_LEAK, failureClass: FailureClass.PERMANENT, ...options });
  }
}

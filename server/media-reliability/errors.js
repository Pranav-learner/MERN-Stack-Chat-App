/**
 * @module media-reliability/errors
 *
 * Typed error hierarchy for the Media Reliability subsystem (Layer 11, Sprint 3). Every error carries a
 * stable `.code` + HTTP `.status`. Mirrors the group-reliability / media error style.
 */

export class MediaReliabilityError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_MEDIAREL";
    this.status = options.status ?? 400;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.details !== undefined) this.details = options.details;
  }
}

export class OperationNotFoundError extends MediaReliabilityError {
  constructor(message = "Media operation record not found", options = {}) {
    super(message, { code: "ERR_MEDIAREL_NOT_FOUND", status: 404, reason: "unknown-operation", ...options });
  }
}

export class InvalidReliabilityTransitionError extends MediaReliabilityError {
  constructor(message = "Invalid reliability transition", options = {}) {
    super(message, { code: "ERR_MEDIAREL_INVALID_TRANSITION", status: 409, reason: "invalid-transition", ...options });
  }
}

export class RecoveryExhaustedError extends MediaReliabilityError {
  constructor(message = "Recovery attempts exhausted", options = {}) {
    super(message, { code: "ERR_MEDIAREL_RECOVERY_EXHAUSTED", status: 422, reason: "recovery-exhausted", ...options });
  }
}

export class RetryBudgetExceededError extends MediaReliabilityError {
  constructor(message = "Retry budget exceeded", options = {}) {
    super(message, { code: "ERR_MEDIAREL_RETRY_BUDGET", status: 429, reason: "retry-budget-exceeded", ...options });
  }
}

export class UnauthorizedReliabilityError extends MediaReliabilityError {
  constructor(message = "Caller is not authorized for this media operation", options = {}) {
    super(message, { code: "ERR_MEDIAREL_FORBIDDEN", status: 403, reason: "unauthorized", ...options });
  }
}

export class ReliabilityValidationError extends MediaReliabilityError {
  constructor(message = "Validation failed", options = {}) {
    super(message, { code: "ERR_MEDIAREL_VALIDATION", status: 400, reason: "malformed-record", ...options });
  }
}

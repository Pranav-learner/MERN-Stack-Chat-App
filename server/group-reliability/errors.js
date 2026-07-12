/**
 * @module group-reliability/errors
 *
 * Typed error hierarchy for the Group Reliability subsystem (Layer 10, Sprint 3). Every error carries a
 * stable `.code` + HTTP `.status`. Mirrors the synchronization-reliability / group-communication style.
 */

export class GroupReliabilityError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_GROUPREL";
    this.status = options.status ?? 400;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.details !== undefined) this.details = options.details;
  }
}

export class OperationNotFoundError extends GroupReliabilityError {
  constructor(message = "Group operation record not found", options = {}) {
    super(message, { code: "ERR_GROUPREL_NOT_FOUND", status: 404, reason: "unknown-operation", ...options });
  }
}

export class InvalidReliabilityTransitionError extends GroupReliabilityError {
  constructor(message = "Invalid reliability transition", options = {}) {
    super(message, { code: "ERR_GROUPREL_INVALID_TRANSITION", status: 409, reason: "invalid-transition", ...options });
  }
}

export class RecoveryExhaustedError extends GroupReliabilityError {
  constructor(message = "Recovery attempts exhausted", options = {}) {
    super(message, { code: "ERR_GROUPREL_RECOVERY_EXHAUSTED", status: 422, reason: "recovery-exhausted", ...options });
  }
}

export class RetryBudgetExceededError extends GroupReliabilityError {
  constructor(message = "Retry budget exceeded", options = {}) {
    super(message, { code: "ERR_GROUPREL_RETRY_BUDGET", status: 429, reason: "retry-budget-exceeded", ...options });
  }
}

export class UnauthorizedReliabilityError extends GroupReliabilityError {
  constructor(message = "Caller is not authorized for this group operation", options = {}) {
    super(message, { code: "ERR_GROUPREL_FORBIDDEN", status: 403, reason: "unauthorized", ...options });
  }
}

export class ReliabilityValidationError extends GroupReliabilityError {
  constructor(message = "Validation failed", options = {}) {
    super(message, { code: "ERR_GROUPREL_VALIDATION", status: 400, reason: "malformed-record", ...options });
  }
}

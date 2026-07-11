/**
 * @module synchronization-reliability/errors
 *
 * Typed error hierarchy for the Synchronization Reliability subsystem (Layer 9, Sprint 3). Every error
 * carries a stable `.code` + HTTP `.status`. Mirrors the transport-reliability / replication style.
 */

export class SyncReliabilityError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_SYNCREL";
    this.status = options.status ?? 400;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.details !== undefined) this.details = options.details;
  }
}

export class SyncRecordNotFoundError extends SyncReliabilityError {
  constructor(message = "Sync reliability record not found", options = {}) {
    super(message, { code: "ERR_SYNCREL_NOT_FOUND", status: 404, ...options });
  }
}

export class InvalidReliabilityTransitionError extends SyncReliabilityError {
  constructor(message = "Invalid reliability transition", options = {}) {
    super(message, { code: "ERR_SYNCREL_INVALID_TRANSITION", status: 409, ...options });
  }
}

export class RecoveryExhaustedError extends SyncReliabilityError {
  constructor(message = "Recovery attempts exhausted", options = {}) {
    super(message, { code: "ERR_SYNCREL_RECOVERY_EXHAUSTED", status: 422, ...options });
  }
}

export class RetryBudgetExceededError extends SyncReliabilityError {
  constructor(message = "Retry budget exceeded", options = {}) {
    super(message, { code: "ERR_SYNCREL_RETRY_BUDGET", status: 429, ...options });
  }
}

export class UnauthorizedReliabilityError extends SyncReliabilityError {
  constructor(message = "Caller is not authorized for this synchronization", options = {}) {
    super(message, { code: "ERR_SYNCREL_FORBIDDEN", status: 403, ...options });
  }
}

export class ReliabilityValidationError extends SyncReliabilityError {
  constructor(message = "Validation failed", options = {}) {
    super(message, { code: "ERR_SYNCREL_VALIDATION", status: 400, ...options });
  }
}

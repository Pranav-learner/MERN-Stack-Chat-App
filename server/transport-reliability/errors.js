/**
 * @module transport-reliability/errors
 *
 * Typed error hierarchy for the Data Plane Reliability subsystem (Layer 8, Sprint 3). Every error
 * carries a stable `.code` + HTTP `.status`. Mirrors the data-plane / transport-engine error style.
 */

export class ReliabilityError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_TRANSREL";
    this.status = options.status ?? 400;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.details !== undefined) this.details = options.details;
  }
}

export class TransferRecordNotFoundError extends ReliabilityError {
  constructor(message = "Transfer reliability record not found", options = {}) {
    super(message, { code: "ERR_TRANSREL_NOT_FOUND", status: 404, ...options });
  }
}

export class InvalidReliabilityTransitionError extends ReliabilityError {
  constructor(message = "Invalid reliability transition", options = {}) {
    super(message, { code: "ERR_TRANSREL_INVALID_TRANSITION", status: 409, ...options });
  }
}

export class RecoveryExhaustedError extends ReliabilityError {
  constructor(message = "Recovery attempts exhausted", options = {}) {
    super(message, { code: "ERR_TRANSREL_RECOVERY_EXHAUSTED", status: 422, ...options });
  }
}

export class MigrationRejectedError extends ReliabilityError {
  constructor(message = "Connection migration rejected", options = {}) {
    super(message, { code: "ERR_TRANSREL_MIGRATION_REJECTED", status: 409, ...options });
  }
}

export class UnauthorizedReliabilityError extends ReliabilityError {
  constructor(message = "Caller is not authorized for this transfer", options = {}) {
    super(message, { code: "ERR_TRANSREL_FORBIDDEN", status: 403, ...options });
  }
}

export class ReliabilityValidationError extends ReliabilityError {
  constructor(message = "Validation failed", options = {}) {
    super(message, { code: "ERR_TRANSREL_VALIDATION", status: 400, ...options });
  }
}

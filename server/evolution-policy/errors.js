/**
 * @module evolution-policy/errors
 *
 * Typed error hierarchy for the Automatic Rekeying engine (Layer 5, Sprint 3). Each error
 * carries a stable `.code` and HTTP `.status`, in its own `ERR_REKEY_*` namespace —
 * distinct from forward-secrecy (`ERR_FS_*`), evolution (`ERR_EVOLUTION_*`), and session
 * (`ERR_SESSION_*`) errors.
 */

/** Base class for all automatic-rekey errors. */
export class RekeyError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_REKEY";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A rekey input (ids, policy, schedule, request shape) failed validation. */
export class RekeyValidationError extends RekeyError {
  constructor(message = "Rekey validation failed", options = {}) {
    super(message, { code: "ERR_REKEY_VALIDATION", status: 400, ...options });
  }
}

/** No automatic-rekey configuration exists for the session. */
export class RekeyNotConfiguredError extends RekeyError {
  constructor(message = "Automatic rekeying is not configured for this session", options = {}) {
    super(message, { code: "ERR_REKEY_NOT_CONFIGURED", status: 404, ...options });
  }
}

/** Two policies conflict (duplicate id, or a second singleton-type policy). */
export class PolicyConflictError extends RekeyError {
  constructor(message = "Evolution policy conflict", options = {}) {
    super(message, { code: "ERR_REKEY_POLICY_CONFLICT", status: 409, ...options });
  }
}

/** A duplicate rekey execution was attempted while one is already active. */
export class DuplicateExecutionError extends RekeyError {
  constructor(message = "A rekey execution is already active for this session", options = {}) {
    super(message, { code: "ERR_REKEY_DUPLICATE", status: 409, ...options });
  }
}

/** The observed generation no longer matches (a concurrent evolution already advanced it). */
export class GenerationMismatchError extends RekeyError {
  constructor(message = "Generation mismatch — session already evolved", options = {}) {
    super(message, { code: "ERR_REKEY_GENERATION_MISMATCH", status: 409, ...options });
  }
}

/** A schedule was invalid (non-positive interval / due time). */
export class InvalidScheduleError extends RekeyError {
  constructor(message = "Invalid rekey schedule", options = {}) {
    super(message, { code: "ERR_REKEY_INVALID_SCHEDULE", status: 400, ...options });
  }
}

/** The session is expired / not in a state that permits evolution. */
export class SessionExpiredError extends RekeyError {
  constructor(message = "Cannot rekey an expired session", options = {}) {
    super(message, { code: "ERR_REKEY_SESSION_EXPIRED", status: 410, ...options });
  }
}

/** The rekey execution itself failed (underlying evolution error, retries exhausted). */
export class RekeyExecutionError extends RekeyError {
  constructor(message = "Rekey execution failed", options = {}) {
    super(message, { code: "ERR_REKEY_EXECUTION", status: 500, ...options });
  }
}

/**
 * @module crypto-hardening/errors
 *
 * Typed error hierarchy for the Cryptographic Hardening subsystem (Layer 5, Sprint 6). Each
 * error carries a stable `.code` and HTTP `.status`, in its own `ERR_HARDENING_*` namespace.
 */

/** Base class for all hardening errors. */
export class HardeningError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_HARDENING";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A hardening input (ids, replay context, metric) failed validation. */
export class HardeningValidationError extends HardeningError {
  constructor(message = "Hardening validation failed", options = {}) {
    super(message, { code: "ERR_HARDENING_VALIDATION", status: 400, ...options });
  }
}

/** A replayed / duplicate / rolled-back message was rejected. */
export class ReplayRejectedError extends HardeningError {
  constructor(message = "Replay rejected", options = {}) {
    super(message, { code: "ERR_HARDENING_REPLAY", status: 409, ...options });
  }
}

/** A key-lifecycle invariant was violated. */
export class LifecycleViolationError extends HardeningError {
  constructor(message = "Key lifecycle violation", options = {}) {
    super(message, { code: "ERR_HARDENING_LIFECYCLE", status: 422, ...options });
  }
}

/** A failure could not be recovered. */
export class UnrecoverableError extends HardeningError {
  constructor(message = "Unrecoverable failure", options = {}) {
    super(message, { code: "ERR_HARDENING_UNRECOVERABLE", status: 500, ...options });
  }
}

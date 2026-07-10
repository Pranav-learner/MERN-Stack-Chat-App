/**
 * @module shs/hardening/errors
 *
 * Typed error hierarchy for the Secure Handshake Hardening subsystem (Layer 4,
 * Sprint 4). Each carries a stable `.code` and HTTP `.status`, in its own
 * `ERR_HARDENING_*` namespace.
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

/** A replayed / duplicate / stale message was detected. */
export class ReplayDetectedError extends HardeningError {
  constructor(message = "Replay detected", options = {}) {
    super(message, { code: "ERR_HARDENING_REPLAY", status: 409, ...options });
  }
}

/** A protocol downgrade attack was detected/blocked. */
export class DowngradeAttackError extends HardeningError {
  constructor(message = "Protocol downgrade blocked", options = {}) {
    super(message, { code: "ERR_HARDENING_DOWNGRADE", status: 426, ...options });
  }
}

/** A protocol-integrity check failed (header/order/state/payload). */
export class ProtocolIntegrityError extends HardeningError {
  constructor(message = "Protocol integrity violation", options = {}) {
    super(message, { code: "ERR_HARDENING_INTEGRITY", status: 400, ...options });
  }
}

/** A handshake could not be recovered and must be aborted. */
export class UnrecoverableError extends HardeningError {
  constructor(message = "Handshake is unrecoverable", options = {}) {
    super(message, { code: "ERR_HARDENING_UNRECOVERABLE", status: 422, ...options });
  }
}

/** Continuous session validation rejected a session. */
export class SessionGuardError extends HardeningError {
  constructor(message = "Session guard rejected the session", options = {}) {
    super(message, { code: "ERR_HARDENING_SESSION_GUARD", status: 403, ...options });
  }
}

/** A hardened repository detected a concurrency conflict (optimistic lock). */
export class ConcurrencyConflictError extends HardeningError {
  constructor(message = "Concurrent modification conflict", options = {}) {
    super(message, { code: "ERR_HARDENING_CONFLICT", status: 409, ...options });
  }
}

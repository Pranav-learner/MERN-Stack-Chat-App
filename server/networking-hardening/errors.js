/**
 * @module networking-hardening/errors
 *
 * Typed error hierarchy for the Networking Hardening subsystem (Layer 6, Sprint 6). Each error
 * carries a stable `.code` and HTTP `.status`, in its own `ERR_NETHARD_*` namespace.
 */

/** Base class for all Networking Hardening errors. */
export class HardeningError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_NETHARD";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A hardening input (ids, config, request shape) failed validation. */
export class HardeningValidationError extends HardeningError {
  constructor(message = "Hardening validation failed", options = {}) {
    super(message, { code: "ERR_NETHARD_VALIDATION", status: 400, ...options });
  }
}

/** A failure could not be recovered (escalated). */
export class UnrecoverableError extends HardeningError {
  constructor(message = "Unrecoverable networking failure", options = {}) {
    super(message, { code: "ERR_NETHARD_UNRECOVERABLE", status: 500, ...options });
  }
}

/** An optimistic-concurrency version conflict that could not be auto-resolved. */
export class ConsistencyConflictError extends HardeningError {
  constructor(message = "Version conflict", options = {}) {
    super(message, { code: "ERR_NETHARD_CONFLICT", status: 409, ...options });
  }
}

/** A rate limit was exceeded. Carries `retryAfterMs`. */
export class RateLimitedError extends HardeningError {
  /** @param {string} message @param {{retryAfterMs?:number, status?:number, details?:object}} [options] */
  constructor(message = "Rate limit exceeded", options = {}) {
    super(message, { code: "ERR_NETHARD_RATE_LIMITED", status: 429, ...options });
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

/** A resilient operation failed because its circuit breaker is open. */
export class CircuitOpenError extends HardeningError {
  constructor(message = "Circuit is open", options = {}) {
    super(message, { code: "ERR_NETHARD_CIRCUIT_OPEN", status: 503, ...options });
  }
}

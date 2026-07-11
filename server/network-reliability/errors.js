/**
 * @module network-reliability/errors
 *
 * Typed error hierarchy for the Network Reliability subsystem (Layer 7, Sprint 3). Each error
 * carries a stable `.code` and HTTP `.status`, in its own `ERR_NETREL_*` namespace.
 */

/** Base class for all Network Reliability errors. */
export class ReliabilityError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_NETREL";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A reliability input (ids, config, connection shape) failed validation. */
export class ReliabilityValidationError extends ReliabilityError {
  constructor(message = "Reliability validation failed", options = {}) {
    super(message, { code: "ERR_NETREL_VALIDATION", status: 400, ...options });
  }
}

/** No active connection exists for the requested id. */
export class ConnectionNotFoundError extends ReliabilityError {
  constructor(message = "Active connection not found", options = {}) {
    super(message, { code: "ERR_NETREL_NOT_FOUND", status: 404, ...options });
  }
}

/** An illegal connection-state transition was attempted. */
export class InvalidTransitionError extends ReliabilityError {
  constructor(message = "Invalid connection state transition", options = {}) {
    super(message, { code: "ERR_NETREL_INVALID_TRANSITION", status: 409, ...options });
  }
}

/** Recovery could not restore the connection (exhausted / unrecoverable). */
export class RecoveryFailedError extends ReliabilityError {
  /** @param {string} message @param {{reason?:string, status?:number, cause?:unknown, details?:object}} [options] */
  constructor(message = "Connection recovery failed", options = {}) {
    super(message, { code: "ERR_NETREL_RECOVERY_FAILED", status: options.status ?? 409, ...options });
    if (options.reason !== undefined) this.reason = options.reason;
  }
}

/** The caller is not permitted to inspect / mutate this connection. */
export class UnauthorizedReliabilityError extends ReliabilityError {
  constructor(message = "Unauthorized connection request", options = {}) {
    super(message, { code: "ERR_NETREL_UNAUTHORIZED", status: 403, ...options });
  }
}

/** A connection record is malformed, tampered, or carries forbidden secret material. */
export class CorruptedConnectionError extends ReliabilityError {
  constructor(message = "Connection record is corrupted", options = {}) {
    super(message, { code: "ERR_NETREL_CORRUPTED", status: 422, ...options });
  }
}

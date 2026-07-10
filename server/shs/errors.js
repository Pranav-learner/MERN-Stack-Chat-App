/**
 * @module shs/errors
 *
 * Typed error hierarchy for the Secure Handshake System (Layer 4). Each error
 * carries a stable `.code` and an HTTP `.status`, and lives in its own `ERR_SHS_*`
 * namespace distinct from identity/device-trust/trust errors.
 *
 * Controllers translate any {@link ShsError} into `{ success:false, code, message }`
 * with the carried status; unknown errors become a generic 500.
 */

/** Base class for all Secure Handshake errors. */
export class ShsError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_SHS";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A handshake input (ids, message shape, metadata) failed validation. */
export class HandshakeValidationError extends ShsError {
  constructor(message = "Handshake validation failed", options = {}) {
    super(message, { code: "ERR_SHS_VALIDATION", status: 400, ...options });
  }
}

/** No handshake session exists for the requested id. */
export class HandshakeNotFoundError extends ShsError {
  constructor(message = "Handshake session not found", options = {}) {
    super(message, { code: "ERR_SHS_NOT_FOUND", status: 404, ...options });
  }
}

/** An illegal state-machine transition was attempted. */
export class InvalidStateTransitionError extends ShsError {
  constructor(message = "Invalid handshake state transition", options = {}) {
    super(message, { code: "ERR_SHS_INVALID_TRANSITION", status: 409, ...options });
  }
}

/** The caller is not a party to (or does not own) the handshake. */
export class HandshakeOwnershipError extends ShsError {
  constructor(message = "Not authorized for this handshake", options = {}) {
    super(message, { code: "ERR_SHS_OWNERSHIP", status: 403, ...options });
  }
}

/** The proposed/observed protocol version is not supported/compatible. */
export class ProtocolVersionError extends ShsError {
  constructor(message = "Incompatible protocol version", options = {}) {
    super(message, { code: "ERR_SHS_VERSION", status: 426, ...options });
  }
}

/** Capability negotiation could not agree on a required feature set. */
export class NegotiationError extends ShsError {
  constructor(message = "Capability negotiation failed", options = {}) {
    super(message, { code: "ERR_SHS_NEGOTIATION", status: 409, ...options });
  }
}

/** A protocol message failed to (de)serialize or is malformed/tampered. */
export class MessageSerializationError extends ShsError {
  constructor(message = "Malformed or unserializable handshake message", options = {}) {
    super(message, { code: "ERR_SHS_SERIALIZATION", status: 400, ...options });
  }
}

/** A duplicate handshake request/message was detected (idempotency/replay guard). */
export class DuplicateHandshakeError extends ShsError {
  constructor(message = "Duplicate handshake request", options = {}) {
    super(message, { code: "ERR_SHS_DUPLICATE", status: 409, ...options });
  }
}

/** The referenced session has expired (past its deadline). */
export class HandshakeExpiredError extends ShsError {
  constructor(message = "Handshake session has expired", options = {}) {
    super(message, { code: "ERR_SHS_EXPIRED", status: 410, ...options });
  }
}

/** A step deadline elapsed with no response. */
export class HandshakeTimeoutError extends ShsError {
  constructor(message = "Handshake step timed out", options = {}) {
    super(message, { code: "ERR_SHS_TIMEOUT", status: 408, ...options });
  }
}

/** The retry budget for a handshake was exhausted. */
export class RetryExhaustedError extends ShsError {
  constructor(message = "Handshake retry budget exhausted", options = {}) {
    super(message, { code: "ERR_SHS_RETRY_EXHAUSTED", status: 429, ...options });
  }
}

/** A referenced identity or device is unknown to the directory. */
export class UnknownPartyError extends ShsError {
  constructor(message = "Unknown identity or device", options = {}) {
    super(message, { code: "ERR_SHS_UNKNOWN_PARTY", status: 404, ...options });
  }
}

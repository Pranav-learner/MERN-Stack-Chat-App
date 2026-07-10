/**
 * @module session-integration/errors
 *
 * Typed error hierarchy for the Secure Session Integration layer (Layer 4, Sprint 5).
 * Each carries a stable `.code` and HTTP `.status`, in its own `ERR_MSG_SESSION_*`
 * namespace. These surface only in STRICT enforcement; in PERMISSIVE mode the layer
 * falls back instead of throwing.
 */

/** Base class for all session-integration errors. */
export class SessionIntegrationError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_MSG_SESSION";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** No session exists between the parties — a handshake must be completed first. */
export class HandshakeRequiredError extends SessionIntegrationError {
  constructor(message = "A secure session is required — complete a handshake first", options = {}) {
    super(message, { code: "ERR_MSG_SESSION_HANDSHAKE_REQUIRED", status: 428, ...options });
  }
}

/** The session backing the operation is expired/invalid and must be re-established. */
export class SessionUnavailableError extends SessionIntegrationError {
  constructor(message = "The secure session is unavailable", options = {}) {
    super(message, { code: "ERR_MSG_SESSION_UNAVAILABLE", status: 409, ...options });
  }
}

/** The resolved session does not match the request's participants. */
export class SessionMismatchError extends SessionIntegrationError {
  constructor(message = "Session participants do not match the message", options = {}) {
    super(message, { code: "ERR_MSG_SESSION_MISMATCH", status: 403, ...options });
  }
}

/** The transport (socket / persistence) is unavailable. */
export class TransportUnavailableError extends SessionIntegrationError {
  constructor(message = "Transport is unavailable", options = {}) {
    super(message, { code: "ERR_MSG_TRANSPORT_UNAVAILABLE", status: 503, ...options });
  }
}

/** The pipeline received malformed input. */
export class PipelineInputError extends SessionIntegrationError {
  constructor(message = "Invalid message pipeline input", options = {}) {
    super(message, { code: "ERR_MSG_PIPELINE_INPUT", status: 400, ...options });
  }
}

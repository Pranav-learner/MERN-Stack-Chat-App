/**
 * @module shs/session/errors
 *
 * Typed error hierarchy for the Secure Session subsystem (Layer 4, Sprint 3). Each
 * carries a stable `.code` and HTTP `.status`, in its own `ERR_SESSION_*` namespace
 * distinct from SHS (`ERR_SHS_*`) and key-agreement (`ERR_KA_*`) errors.
 */

/** Base class for all Secure Session errors. */
export class SessionError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_SESSION";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A session input (ids, metadata, params) failed validation. */
export class SessionValidationError extends SessionError {
  constructor(message = "Session validation failed", options = {}) {
    super(message, { code: "ERR_SESSION_VALIDATION", status: 400, ...options });
  }
}

/** No session exists for the requested id. */
export class SessionNotFoundError extends SessionError {
  constructor(message = "Session not found", options = {}) {
    super(message, { code: "ERR_SESSION_NOT_FOUND", status: 404, ...options });
  }
}

/** An illegal lifecycle transition was attempted. */
export class InvalidSessionTransitionError extends SessionError {
  constructor(message = "Invalid session state transition", options = {}) {
    super(message, { code: "ERR_SESSION_INVALID_TRANSITION", status: 409, ...options });
  }
}

/** The session has expired (max lifetime or idle timeout). */
export class SessionExpiredError extends SessionError {
  constructor(message = "Session has expired", options = {}) {
    super(message, { code: "ERR_SESSION_EXPIRED", status: 410, ...options });
  }
}

/** A second active session was created for a handshake that already has one. */
export class DuplicateSessionError extends SessionError {
  constructor(message = "An active session already exists for this handshake", options = {}) {
    super(message, { code: "ERR_SESSION_DUPLICATE", status: 409, ...options });
  }
}

/** The session's participants/devices do not match the expected ones. */
export class ParticipantMismatchError extends SessionError {
  constructor(message = "Session participants do not match", options = {}) {
    super(message, { code: "ERR_SESSION_PARTICIPANT_MISMATCH", status: 403, ...options });
  }
}

/** Session metadata is malformed or corrupted. */
export class CorruptedMetadataError extends SessionError {
  constructor(message = "Session metadata is corrupted", options = {}) {
    super(message, { code: "ERR_SESSION_CORRUPTED_METADATA", status: 422, ...options });
  }
}

/** Session key derivation failed. */
export class KeyDerivationError extends SessionError {
  constructor(message = "Session key derivation failed", options = {}) {
    super(message, { code: "ERR_SESSION_KEY_DERIVATION", status: 500, ...options });
  }
}

/** A resume token is malformed, expired, or has a bad signature. */
export class ResumptionError extends SessionError {
  constructor(message = "Session resumption failed", options = {}) {
    super(message, { code: "ERR_SESSION_RESUMPTION", status: 401, ...options });
  }
}

/** A rekey operation could not complete. */
export class RekeyError extends SessionError {
  constructor(message = "Session rekey failed", options = {}) {
    super(message, { code: "ERR_SESSION_REKEY", status: 409, ...options });
  }
}

/** This operation requires device mode (a secure key store + shared secret). */
export class DeviceModeRequiredError extends SessionError {
  constructor(message = "Operation requires device mode (secure key store)", options = {}) {
    super(message, { code: "ERR_SESSION_DEVICE_MODE_REQUIRED", status: 400, ...options });
  }
}

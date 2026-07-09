/**
 * @module trust/errors
 *
 * Typed error hierarchy for the Trust subsystem. Each carries a stable `.code`
 * and HTTP `.status`. Distinct namespace from identity/device-trust errors.
 */

/** Base class for all Trust errors. */
export class TrustError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_TRUST";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A trust input (fingerprint, metadata, id) failed validation. */
export class TrustValidationError extends TrustError {
  constructor(message = "Trust validation failed", options = {}) {
    super(message, { code: "ERR_TRUST_VALIDATION", status: 400, ...options });
  }
}

/** The subject has no identity to verify. */
export class UnknownIdentityError extends TrustError {
  constructor(message = "Identity not found for subject", options = {}) {
    super(message, { code: "ERR_UNKNOWN_IDENTITY", status: 404, ...options });
  }
}

/** No verification record exists for the requested pair. */
export class VerificationNotFoundError extends TrustError {
  constructor(message = "Verification not found", options = {}) {
    super(message, { code: "ERR_VERIFICATION_NOT_FOUND", status: 404, ...options });
  }
}

/** The safety number the verifier observed does not match the computed one. */
export class SafetyNumberMismatchError extends TrustError {
  constructor(message = "Safety number mismatch — possible impersonation", options = {}) {
    super(message, { code: "ERR_SAFETY_NUMBER_MISMATCH", status: 409, ...options });
  }
}

/** The observed fingerprint does not match the subject's current fingerprint. */
export class FingerprintMismatchError extends TrustError {
  constructor(message = "Fingerprint mismatch", options = {}) {
    super(message, { code: "ERR_FINGERPRINT_MISMATCH", status: 409, ...options });
  }
}

/** A QR verification payload is malformed or tampered. */
export class InvalidQrPayloadError extends TrustError {
  constructor(message = "Invalid or tampered QR payload", options = {}) {
    super(message, { code: "ERR_INVALID_QR_PAYLOAD", status: 400, ...options });
  }
}

/** An illegal trust-state transition was attempted. */
export class InvalidTrustTransitionError extends TrustError {
  constructor(message = "Invalid trust transition", options = {}) {
    super(message, { code: "ERR_INVALID_TRUST_TRANSITION", status: 409, ...options });
  }
}

/** The caller does not own the verification record. */
export class VerificationOwnershipError extends TrustError {
  constructor(message = "Not authorized for this verification", options = {}) {
    super(message, { code: "ERR_VERIFICATION_OWNERSHIP", status: 403, ...options });
  }
}

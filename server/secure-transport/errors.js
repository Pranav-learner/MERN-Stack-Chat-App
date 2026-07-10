/**
 * @module secure-transport/errors
 *
 * Typed error hierarchy for the Secure Transport Layer (Layer 4, Sprint 6). Each
 * carries a stable `.code` and HTTP `.status`, in its own `ERR_TRANSPORT_*` namespace.
 *
 * @security Error messages never include plaintext, keys, or ciphertext bytes — only
 * safe metadata (ids, versions, reasons).
 */

/** Base class for all Secure Transport errors. */
export class SecureTransportError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_TRANSPORT";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A secure payload is malformed / missing required fields. */
export class MalformedPayloadError extends SecureTransportError {
  constructor(message = "Malformed secure payload", options = {}) {
    super(message, { code: "ERR_TRANSPORT_MALFORMED", status: 400, ...options });
  }
}

/** Integrity (MAC or AEAD tag) verification failed — corrupted or tampered. */
export class IntegrityError extends SecureTransportError {
  constructor(message = "Integrity verification failed", options = {}) {
    super(message, { code: "ERR_TRANSPORT_INTEGRITY", status: 400, ...options });
  }
}

/** Decryption failed (wrong key/session, corrupted ciphertext). */
export class DecryptionError extends SecureTransportError {
  constructor(message = "Decryption failed", options = {}) {
    super(message, { code: "ERR_TRANSPORT_DECRYPTION", status: 400, ...options });
  }
}

/** The payload's protocol/envelope version is unsupported. */
export class VersionMismatchError extends SecureTransportError {
  constructor(message = "Unsupported secure payload version", options = {}) {
    super(message, { code: "ERR_TRANSPORT_VERSION", status: 400, ...options });
  }
}

/** No session keys available to encrypt/decrypt (missing/locked session). */
export class SessionKeyError extends SecureTransportError {
  constructor(message = "Session keys unavailable", options = {}) {
    super(message, { code: "ERR_TRANSPORT_KEYS", status: 409, ...options });
  }
}

/** The payload does not belong to the expected session/device. */
export class SessionMismatchError extends SecureTransportError {
  constructor(message = "Secure payload session/device mismatch", options = {}) {
    super(message, { code: "ERR_TRANSPORT_SESSION_MISMATCH", status: 403, ...options });
  }
}

/** A transport (send/receive) operation failed. */
export class TransportError extends SecureTransportError {
  constructor(message = "Transport operation failed", options = {}) {
    super(message, { code: "ERR_TRANSPORT_SEND", status: 503, ...options });
  }
}

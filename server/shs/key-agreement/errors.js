/**
 * @module shs/key-agreement/errors
 *
 * Typed error hierarchy for the Secure Key Agreement subsystem (Layer 4, Sprint 2).
 * Each carries a stable `.code` and HTTP `.status`, in its own `ERR_KA_*` namespace
 * distinct from the SHS (`ERR_SHS_*`) and Layer 3 errors.
 */

/** Base class for all Key Agreement errors. */
export class KeyAgreementError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_KA";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A key-agreement input (ids, payload, metadata) failed validation. */
export class KeyAgreementValidationError extends KeyAgreementError {
  constructor(message = "Key agreement validation failed", options = {}) {
    super(message, { code: "ERR_KA_VALIDATION", status: 400, ...options });
  }
}

/** A peer public key is malformed, wrong length, or an unsafe point. */
export class InvalidPublicKeyError extends KeyAgreementError {
  constructor(message = "Invalid ephemeral public key", options = {}) {
    super(message, { code: "ERR_KA_INVALID_PUBLIC_KEY", status: 400, ...options });
  }
}

/** Ephemeral key generation failed. */
export class EphemeralKeyError extends KeyAgreementError {
  constructor(message = "Ephemeral key operation failed", options = {}) {
    super(message, { code: "ERR_KA_EPHEMERAL_KEY", status: 500, ...options });
  }
}

/** The referenced ephemeral private key is not held locally (destroyed/never generated). */
export class EphemeralKeyNotFoundError extends KeyAgreementError {
  constructor(message = "No local ephemeral key for this handshake/role", options = {}) {
    super(message, { code: "ERR_KA_EPHEMERAL_NOT_FOUND", status: 409, ...options });
  }
}

/** Shared-secret derivation produced an unsafe/invalid result. */
export class SharedSecretError extends KeyAgreementError {
  constructor(message = "Shared secret derivation failed", options = {}) {
    super(message, { code: "ERR_KA_SHARED_SECRET", status: 500, ...options });
  }
}

/** Two parties' derived shared secrets (via commitments) do not match. */
export class SharedSecretMismatchError extends KeyAgreementError {
  constructor(message = "Shared secret commitments do not match — possible MITM", options = {}) {
    super(message, { code: "ERR_KA_SECRET_MISMATCH", status: 409, ...options });
  }
}

/** Cryptographic negotiation (algorithm / version) could not agree. */
export class CryptoNegotiationError extends KeyAgreementError {
  constructor(message = "Cryptographic negotiation failed", options = {}) {
    super(message, { code: "ERR_KA_NEGOTIATION", status: 409, ...options });
  }
}

/** A duplicate ephemeral key / exchange step was submitted (idempotency guard). */
export class DuplicateExchangeError extends KeyAgreementError {
  constructor(message = "Duplicate key-exchange submission", options = {}) {
    super(message, { code: "ERR_KA_DUPLICATE", status: 409, ...options });
  }
}

/** A replayed ephemeral key / commitment was detected. */
export class ReplayError extends KeyAgreementError {
  constructor(message = "Replay detected in key agreement", options = {}) {
    super(message, { code: "ERR_KA_REPLAY", status: 409, ...options });
  }
}

/** The key-exchange record has expired. */
export class KeyAgreementExpiredError extends KeyAgreementError {
  constructor(message = "Key agreement has expired", options = {}) {
    super(message, { code: "ERR_KA_EXPIRED", status: 410, ...options });
  }
}

/** No key-exchange record for the requested handshake. */
export class ExchangeNotFoundError extends KeyAgreementError {
  constructor(message = "Key-exchange record not found", options = {}) {
    super(message, { code: "ERR_KA_EXCHANGE_NOT_FOUND", status: 404, ...options });
  }
}

/** No local session material for the requested handshake. */
export class SessionMaterialNotFoundError extends KeyAgreementError {
  constructor(message = "Session material not found", options = {}) {
    super(message, { code: "ERR_KA_MATERIAL_NOT_FOUND", status: 404, ...options });
  }
}

/** The peer's identity signature over its ephemeral key failed to verify. */
export class PeerAuthenticationError extends KeyAgreementError {
  constructor(message = "Peer ephemeral key failed identity authentication", options = {}) {
    super(message, { code: "ERR_KA_PEER_AUTH", status: 401, ...options });
  }
}

/** An unknown identity/device was referenced in the key agreement. */
export class UnknownPeerError extends KeyAgreementError {
  constructor(message = "Unknown peer identity/device", options = {}) {
    super(message, { code: "ERR_KA_UNKNOWN_PEER", status: 404, ...options });
  }
}

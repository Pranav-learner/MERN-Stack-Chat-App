/**
 * @module forward-secrecy/errors
 *
 * Typed error hierarchy for the Forward Secrecy Engine (Layer 5, Sprint 2). Each error
 * carries a stable `.code` and HTTP `.status`, in its own `ERR_FS_*` namespace — distinct
 * from evolution (`ERR_EVOLUTION_*`), session (`ERR_SESSION_*`), and transport
 * (`ERR_TRANSPORT_*`) errors.
 *
 * @security Error messages + details carry METADATA only (session ids, generation
 * numbers, key ids) — never key bytes or secrets.
 */

/** Base class for all Forward Secrecy errors. */
export class ForwardSecrecyError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_FS";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A forward-secrecy input (ids, request shape, generation) failed validation. */
export class ForwardSecrecyValidationError extends ForwardSecrecyError {
  constructor(message = "Forward secrecy validation failed", options = {}) {
    super(message, { code: "ERR_FS_VALIDATION", status: 400, ...options });
  }
}

/** No forward-secrecy state / generation exists for the request. */
export class GenerationNotFoundError extends ForwardSecrecyError {
  constructor(message = "Forward secrecy state not found", options = {}) {
    super(message, { code: "ERR_FS_NOT_FOUND", status: 404, ...options });
  }
}

/** This operation requires device mode (a device-local FS key store). */
export class KeyStoreRequiredError extends ForwardSecrecyError {
  constructor(message = "Operation requires a device-local forward-secrecy key store", options = {}) {
    super(message, { code: "ERR_FS_KEYSTORE_REQUIRED", status: 400, ...options });
  }
}

/** Forward secrecy was already started for a session (or not started when required). */
export class ForwardSecrecyStateError extends ForwardSecrecyError {
  constructor(message = "Forward secrecy state error", options = {}) {
    super(message, { code: "ERR_FS_STATE", status: 409, ...options });
  }
}

/** A generation advanced out of order (gap, or not exactly +1). */
export class GenerationOrderingError extends ForwardSecrecyError {
  constructor(message = "Generation ordering violation", options = {}) {
    super(message, { code: "ERR_FS_GENERATION_ORDERING", status: 409, ...options });
  }
}

/** A rollback to an older-or-equal generation was attempted (rollback prevention). */
export class RollbackDetectedError extends ForwardSecrecyError {
  constructor(message = "Generation rollback detected", options = {}) {
    super(message, { code: "ERR_FS_ROLLBACK", status: 409, ...options });
  }
}

/** An evolution to a generation already present in history was replayed. */
export class ReplayDetectedError extends ForwardSecrecyError {
  constructor(message = "Evolution replay detected", options = {}) {
    super(message, { code: "ERR_FS_REPLAY", status: 409, ...options });
  }
}

/** A reference to already-destroyed key material was used. */
export class DestroyedKeyReferenceError extends ForwardSecrecyError {
  constructor(message = "Reference to destroyed key material", options = {}) {
    super(message, { code: "ERR_FS_DESTROYED_KEY", status: 410, ...options });
  }
}

/** The caller is not an owner/participant of the session. */
export class SessionOwnershipError extends ForwardSecrecyError {
  constructor(message = "Caller is not an owner of this session", options = {}) {
    super(message, { code: "ERR_FS_OWNERSHIP", status: 403, ...options });
  }
}

/** An evolution failed mid-flight; intermediate material was destroyed. */
export class EvolutionFailedError extends ForwardSecrecyError {
  constructor(message = "Forward secrecy evolution failed", options = {}) {
    super(message, { code: "ERR_FS_EVOLUTION_FAILED", status: 500, ...options });
  }
}

/** Chain / key derivation failed. */
export class ChainDerivationError extends ForwardSecrecyError {
  constructor(message = "Forward secrecy key derivation failed", options = {}) {
    super(message, { code: "ERR_FS_DERIVATION", status: 500, ...options });
  }
}

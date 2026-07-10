/**
 * @module key-hierarchy/errors
 *
 * Typed error hierarchy for the Key Hierarchy subsystem (Layer 5, Sprint 4). Each error
 * carries a stable `.code` and HTTP `.status`, in its own `ERR_KH_*` namespace — distinct
 * from forward-secrecy (`ERR_FS_*`), rekey (`ERR_REKEY_*`), and session (`ERR_SESSION_*`).
 */

/** Base class for all key-hierarchy errors. */
export class KeyHierarchyError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_KH";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A hierarchy input (ids, root key, chain state) failed validation. */
export class KeyHierarchyValidationError extends KeyHierarchyError {
  constructor(message = "Key hierarchy validation failed", options = {}) {
    super(message, { code: "ERR_KH_VALIDATION", status: 400, ...options });
  }
}

/** No hierarchy / chain exists for the request. */
export class HierarchyNotFoundError extends KeyHierarchyError {
  constructor(message = "Key hierarchy not found", options = {}) {
    super(message, { code: "ERR_KH_NOT_FOUND", status: 404, ...options });
  }
}

/** This operation requires device mode (a device-local key store). */
export class KeyStoreRequiredError extends KeyHierarchyError {
  constructor(message = "Operation requires a device-local key store", options = {}) {
    super(message, { code: "ERR_KH_KEYSTORE_REQUIRED", status: 400, ...options });
  }
}

/** A hierarchy already exists for a session (or is missing when required). */
export class HierarchyStateError extends KeyHierarchyError {
  constructor(message = "Key hierarchy state error", options = {}) {
    super(message, { code: "ERR_KH_STATE", status: 409, ...options });
  }
}

/** A root key is invalid / malformed. */
export class InvalidRootKeyError extends KeyHierarchyError {
  constructor(message = "Invalid root key", options = {}) {
    super(message, { code: "ERR_KH_INVALID_ROOT", status: 400, ...options });
  }
}

/** A chain does not match the expected chain (direction/role/generation). */
export class ChainMismatchError extends KeyHierarchyError {
  constructor(message = "Chain mismatch", options = {}) {
    super(message, { code: "ERR_KH_CHAIN_MISMATCH", status: 409, ...options });
  }
}

/** A chain index moved backwards (rollback prevention). */
export class ChainRollbackError extends KeyHierarchyError {
  constructor(message = "Chain index rollback detected", options = {}) {
    super(message, { code: "ERR_KH_CHAIN_ROLLBACK", status: 409, ...options });
  }
}

/** A required chain is missing. */
export class MissingChainError extends KeyHierarchyError {
  constructor(message = "Chain not found", options = {}) {
    super(message, { code: "ERR_KH_MISSING_CHAIN", status: 404, ...options });
  }
}

/** A duplicate chain was created. */
export class DuplicateChainError extends KeyHierarchyError {
  constructor(message = "Duplicate chain", options = {}) {
    super(message, { code: "ERR_KH_DUPLICATE_CHAIN", status: 409, ...options });
  }
}

/** Hierarchy metadata is malformed / corrupted / carries key material. */
export class CorruptedHierarchyError extends KeyHierarchyError {
  constructor(message = "Key hierarchy metadata is corrupted", options = {}) {
    super(message, { code: "ERR_KH_CORRUPTED", status: 422, ...options });
  }
}

/** Root/chain key derivation failed. */
export class KeyHierarchyDerivationError extends KeyHierarchyError {
  constructor(message = "Key hierarchy derivation failed", options = {}) {
    super(message, { code: "ERR_KH_DERIVATION", status: 500, ...options });
  }
}

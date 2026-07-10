/**
 * @module message-keys/errors
 *
 * Typed error hierarchy for the Per-Message Key subsystem (Layer 5, Sprint 5). Each error
 * carries a stable `.code` and HTTP `.status`, in its own `ERR_MK_*` namespace — distinct
 * from key-hierarchy (`ERR_KH_*`), forward-secrecy (`ERR_FS_*`), and session (`ERR_SESSION_*`).
 */

/** Base class for all message-key errors. */
export class MessageKeyError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,cause?:unknown,details?:object}} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_MK";
    this.status = options.status ?? 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** A message-key input (ids, message number, metadata) failed validation. */
export class MessageKeyValidationError extends MessageKeyError {
  constructor(message = "Message key validation failed", options = {}) {
    super(message, { code: "ERR_MK_VALIDATION", status: 400, ...options });
  }
}

/** No message-key state / session exists for the request. */
export class MessageKeyNotFoundError extends MessageKeyError {
  constructor(message = "Message key state not found", options = {}) {
    super(message, { code: "ERR_MK_NOT_FOUND", status: 404, ...options });
  }
}

/** This operation requires device mode (a chain manager with a device key store). */
export class KeyStoreRequiredError extends MessageKeyError {
  constructor(message = "Operation requires a device-local chain key store", options = {}) {
    super(message, { code: "ERR_MK_KEYSTORE_REQUIRED", status: 400, ...options });
  }
}

/** A duplicate message number was produced/received. */
export class DuplicateMessageNumberError extends MessageKeyError {
  constructor(message = "Duplicate message number", options = {}) {
    super(message, { code: "ERR_MK_DUPLICATE_NUMBER", status: 409, ...options });
  }
}

/** The referenced chain is missing / of a different generation. */
export class ChainResolutionError extends MessageKeyError {
  constructor(message = "Chain could not be resolved", options = {}) {
    super(message, { code: "ERR_MK_CHAIN", status: 409, ...options });
  }
}

/** The message's generation does not match the active chain generation. */
export class GenerationMismatchError extends MessageKeyError {
  constructor(message = "Message generation mismatch", options = {}) {
    super(message, { code: "ERR_MK_GENERATION_MISMATCH", status: 409, ...options });
  }
}

/** A message key that was already used/destroyed was referenced again (replay). */
export class DestroyedKeyReuseError extends MessageKeyError {
  constructor(message = "Message key already used/destroyed (possible replay)", options = {}) {
    super(message, { code: "ERR_MK_DESTROYED_REUSE", status: 410, ...options });
  }
}

/** The out-of-order gap exceeds the maximum skip (DoS guard). */
export class TooManySkippedError extends MessageKeyError {
  constructor(message = "Too many skipped messages", options = {}) {
    super(message, { code: "ERR_MK_TOO_MANY_SKIPPED", status: 429, ...options });
  }
}

/** Message-key derivation failed. */
export class MessageKeyDerivationError extends MessageKeyError {
  constructor(message = "Message key derivation failed", options = {}) {
    super(message, { code: "ERR_MK_DERIVATION", status: 500, ...options });
  }
}

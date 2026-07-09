/**
 * @module errors
 *
 * Typed error hierarchy for the Key Management System. Every KMS error extends
 * {@link KeyManagementError} and carries a stable, machine-readable `.code` plus
 * an optional `.cause`. This is intentionally separate from the Crypto SDK's
 * `CryptoError` hierarchy so the two layers stay decoupled; callers that want a
 * single catch can still match on `Error`.
 */

/** Options accepted by every KMS error constructor. */
export interface KeyManagementErrorOptions {
  code?: string;
  cause?: unknown;
  /** Optional structured detail (e.g. the offending keyId or field). */
  details?: Record<string, unknown>;
}

/** Base class for all Key Management System errors. */
export class KeyManagementError extends Error {
  /** Stable, machine-readable error code. */
  public readonly code: string;
  /** Optional structured detail for diagnostics (never contains secret bytes). */
  public readonly details?: Record<string, unknown>;

  constructor(message: string, options: KeyManagementErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_KEY_MANAGEMENT";
    if (options.details !== undefined) this.details = options.details;
    Object.setPrototypeOf(this, new.target.prototype);
    if (typeof (Error as { captureStackTrace?: unknown }).captureStackTrace === "function") {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/** A key with the requested id/criteria does not exist. */
export class KeyNotFoundError extends KeyManagementError {
  constructor(message = "Key not found", options: KeyManagementErrorOptions = {}) {
    super(message, { code: "ERR_KEY_NOT_FOUND", ...options });
  }
}

/** Attempted to store a key whose id already exists. */
export class DuplicateKeyError extends KeyManagementError {
  constructor(message = "Key already exists", options: KeyManagementErrorOptions = {}) {
    super(message, { code: "ERR_DUPLICATE_KEY", ...options });
  }
}

/** A key or its metadata failed validation (bad format, length, or fingerprint). */
export class KeyValidationError extends KeyManagementError {
  constructor(message = "Key validation failed", options: KeyManagementErrorOptions = {}) {
    super(message, { code: "ERR_KEY_VALIDATION", ...options });
  }
}

/** A key is past its `expiresAt` timestamp. */
export class KeyExpiredError extends KeyManagementError {
  constructor(message = "Key has expired", options: KeyManagementErrorOptions = {}) {
    super(message, { code: "ERR_KEY_EXPIRED", ...options });
  }
}

/** A storage backend operation failed (including "not implemented" placeholders). */
export class StorageFailureError extends KeyManagementError {
  constructor(message = "Storage operation failed", options: KeyManagementErrorOptions = {}) {
    super(message, { code: "ERR_STORAGE_FAILURE", ...options });
  }
}

/** Serialization to a portable form failed. */
export class SerializationError extends KeyManagementError {
  constructor(message = "Serialization failed", options: KeyManagementErrorOptions = {}) {
    super(message, { code: "ERR_SERIALIZATION", ...options });
  }
}

/** Importing a key from an external representation failed. */
export class ImportError extends KeyManagementError {
  constructor(message = "Key import failed", options: KeyManagementErrorOptions = {}) {
    super(message, { code: "ERR_IMPORT", ...options });
  }
}

/** Exporting a key to an external representation failed. */
export class ExportError extends KeyManagementError {
  constructor(message = "Key export failed", options: KeyManagementErrorOptions = {}) {
    super(message, { code: "ERR_EXPORT", ...options });
  }
}

/** A rotation operation could not be completed. */
export class RotationError extends KeyManagementError {
  constructor(message = "Key rotation failed", options: KeyManagementErrorOptions = {}) {
    super(message, { code: "ERR_ROTATION", ...options });
  }
}

/** A recovery operation failed or is unsupported (future hook). */
export class RecoveryError extends KeyManagementError {
  constructor(message = "Key recovery failed", options: KeyManagementErrorOptions = {}) {
    super(message, { code: "ERR_RECOVERY", ...options });
  }
}

/** A serialized key uses an unsupported format version. */
export class UnsupportedVersionError extends KeyManagementError {
  constructor(message = "Unsupported key format version", options: KeyManagementErrorOptions = {}) {
    super(message, { code: "ERR_UNSUPPORTED_VERSION", ...options });
  }
}

/** A format migration failed. */
export class MigrationError extends KeyManagementError {
  constructor(message = "Key migration failed", options: KeyManagementErrorOptions = {}) {
    super(message, { code: "ERR_MIGRATION", ...options });
  }
}

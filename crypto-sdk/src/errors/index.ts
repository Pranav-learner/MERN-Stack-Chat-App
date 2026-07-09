/**
 * @module errors
 *
 * Typed error hierarchy for the Crypto SDK.
 *
 * Every error thrown by the SDK is (a subclass of) {@link CryptoError}, so a
 * consumer can `catch (e) { if (e instanceof CryptoError) … }` and branch on the
 * stable, machine-readable `.code`. Error *messages* are human-oriented and may
 * change; the `.code` and the class are the contract.
 *
 * Design notes:
 * - No secret material (keys, plaintext) is ever placed in an error message.
 * - `cause` carries the underlying native error (e.g. an OpenSSL failure) for
 *   debugging, following the standard `Error` `cause` option shape.
 */

/** Options accepted by every SDK error constructor. */
export interface CryptoErrorOptions {
  /** Machine-readable, stable error code (e.g. `ERR_DECRYPTION`). */
  code?: string;
  /** Underlying error that triggered this one, if any. */
  cause?: unknown;
}

/**
 * Base class for all Crypto SDK errors.
 *
 * @example
 * ```ts
 * import { decrypt, CryptoError, DecryptionError } from "@securechat/crypto-sdk";
 *
 * try {
 *   decrypt(key, payload);
 * } catch (err) {
 *   if (err instanceof DecryptionError) {
 *     // authentication failed — treat as tampering
 *   } else if (err instanceof CryptoError) {
 *     console.error(err.code, err.message);
 *   }
 * }
 * ```
 */
export class CryptoError extends Error {
  /** Stable, machine-readable error code. */
  public readonly code: string;

  constructor(message: string, options: CryptoErrorOptions = {}) {
    // Forward `cause` to the native Error for standard `.cause` support.
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "ERR_CRYPTO";
    // Restore prototype chain (required when targeting ES5-ish emit / extending Error).
    Object.setPrototypeOf(this, new.target.prototype);
    if (typeof (Error as { captureStackTrace?: unknown }).captureStackTrace === "function") {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/** Thrown when symmetric/asymmetric encryption fails. */
export class EncryptionError extends CryptoError {
  constructor(message = "Encryption failed", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_ENCRYPTION", ...options });
  }
}

/**
 * Thrown when decryption or AEAD authentication fails.
 *
 * IMPORTANT: A {@link DecryptionError} is the *expected* signal for tampered
 * ciphertext, a wrong key, or a wrong nonce — GCM cannot distinguish these, and
 * neither can callers. Treat it uniformly as "this ciphertext is not authentic".
 */
export class DecryptionError extends CryptoError {
  constructor(message = "Decryption failed", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_DECRYPTION", ...options });
  }
}

/** Thrown when a key is malformed, the wrong algorithm, or the wrong length. */
export class InvalidKeyError extends CryptoError {
  constructor(message = "Invalid key", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_INVALID_KEY", ...options });
  }
}

/** Thrown when a signature is structurally invalid (not "verification returned false"). */
export class InvalidSignatureError extends CryptoError {
  constructor(message = "Invalid signature", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_INVALID_SIGNATURE", ...options });
  }
}

/** Thrown when a ciphertext / encrypted payload is structurally invalid. */
export class InvalidCiphertextError extends CryptoError {
  constructor(message = "Invalid ciphertext", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_INVALID_CIPHERTEXT", ...options });
  }
}

/** Thrown when importing a key from an external representation fails. */
export class KeyImportError extends CryptoError {
  constructor(message = "Key import failed", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_KEY_IMPORT", ...options });
  }
}

/** Thrown when exporting a key to an external representation fails. */
export class KeyExportError extends CryptoError {
  constructor(message = "Key export failed", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_KEY_EXPORT", ...options });
  }
}

/** Thrown when the platform CSPRNG fails to produce random bytes. */
export class RandomGenerationError extends CryptoError {
  constructor(message = "Secure random generation failed", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_RANDOM_GENERATION", ...options });
  }
}

/** Thrown when encoding/decoding (base64, hex, utf-8, …) fails or receives malformed input. */
export class EncodingError extends CryptoError {
  constructor(message = "Encoding error", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_ENCODING", ...options });
  }
}

/** Thrown when a hashing operation fails. */
export class HashingError extends CryptoError {
  constructor(message = "Hashing failed", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_HASHING", ...options });
  }
}

/** Thrown when key derivation (HKDF / scrypt) fails. */
export class KeyDerivationError extends CryptoError {
  constructor(message = "Key derivation failed", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_KEY_DERIVATION", ...options });
  }
}

/** Thrown when a public API receives an argument that fails validation. */
export class ValidationError extends CryptoError {
  constructor(message = "Invalid argument", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_VALIDATION", ...options });
  }
}

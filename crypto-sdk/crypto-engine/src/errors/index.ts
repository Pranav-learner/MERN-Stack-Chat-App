/**
 * @module errors
 *
 * Engine-specific errors. They extend the Sprint 1 {@link CryptoError} so callers
 * can catch the whole crypto family uniformly (`instanceof CryptoError`) while
 * still branching on the engine's more specific classes / stable `.code`s.
 */

import { CryptoError, type CryptoErrorOptions } from "@securechat/crypto-sdk";

export { CryptoError };
export type { CryptoErrorOptions };

/** Base class for all Crypto Engine errors. */
export class CryptoEngineError extends CryptoError {
  constructor(message = "Crypto engine error", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_CRYPTO_ENGINE", ...options });
  }
}

/** A streaming/chunked operation failed (bad frame order, truncation, etc.). */
export class StreamError extends CryptoEngineError {
  constructor(message = "Stream processing failed", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_STREAM", ...options });
  }
}

/** A file-encryption operation failed. */
export class FileEncryptionError extends CryptoEngineError {
  constructor(message = "File encryption failed", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_FILE_ENCRYPTION", ...options });
  }
}

/** An integrity check failed (corruption, tampering, checksum/version mismatch). */
export class IntegrityError extends CryptoEngineError {
  constructor(message = "Integrity verification failed", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_INTEGRITY", ...options });
  }
}

/** A public key failed validation (bad length, low-order point, wrong algorithm). */
export class PublicKeyValidationError extends CryptoEngineError {
  constructor(message = "Public key validation failed", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_PUBLIC_KEY_VALIDATION", ...options });
  }
}

/** A key-derivation operation failed. */
export class DerivationError extends CryptoEngineError {
  constructor(message = "Key derivation failed", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_DERIVATION", ...options });
  }
}

/** A payload model could not be (de)serialized. */
export class PayloadError extends CryptoEngineError {
  constructor(message = "Payload error", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_PAYLOAD", ...options });
  }
}

/** A benchmark could not be run. */
export class BenchmarkError extends CryptoEngineError {
  constructor(message = "Benchmark failed", options: CryptoErrorOptions = {}) {
    super(message, { code: "ERR_BENCHMARK", ...options });
  }
}

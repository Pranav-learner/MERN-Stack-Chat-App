/**
 * @module kdf
 *
 * Key Derivation Functions.
 *
 * - {@link hkdf} — HKDF (RFC 5869), for deriving one or more strong keys from a
 *   high-entropy input such as an X25519 shared secret. This is the primary way
 *   future modules should turn a {@link SharedSecret} into session/message keys.
 * - {@link deriveKeyFromPassword} — scrypt, a memory-hard KDF for the *separate*
 *   problem of stretching a low-entropy human password. Provided for completeness;
 *   it is NOT used by the transport/session paths.
 *
 * Both delegate to Node/OpenSSL. No KDF is implemented by hand.
 */

import { hkdfSync, scryptSync } from "node:crypto";
import { HashAlgorithm } from "../constants/index.js";
import { KeyDerivationError, ValidationError } from "../errors/index.js";
import { coerceToBytes, assertInteger } from "../utils/index.js";

/** Options for {@link hkdf}. */
export interface HkdfOptions {
  /**
   * Optional salt. If omitted, a zero-length salt is used (HKDF then falls back
   * to `HashLen` zero bytes internally, per RFC 5869). A random, per-context salt
   * is recommended when available.
   */
  salt?: Uint8Array | string;
  /**
   * Optional context/application `info` binding. Strongly recommended: include a
   * label such as `"securechat:session:v1"` so keys derived for different
   * purposes from the same secret are independent.
   */
  info?: Uint8Array | string;
  /** Output length in bytes (default 32). Must be `<= 255 * HashLen`. */
  length?: number;
  /** Underlying hash (default SHA-256). */
  hash?: HashAlgorithm;
}

/**
 * HKDF-Extract-then-Expand (RFC 5869): derive `length` pseudorandom bytes from
 * input keying material `ikm`.
 *
 * @param ikm high-entropy input keying material (e.g. an ECDH shared secret).
 * @param options salt, info, length, hash — see {@link HkdfOptions}.
 * @throws {ValidationError} for out-of-range length.
 * @throws {KeyDerivationError} if the underlying derivation fails.
 *
 * @example
 * ```ts
 * const key = hkdf(sharedSecretBytes, {
 *   salt: randomBytes(16),
 *   info: "securechat:handshake:v1",
 *   length: 32,
 * });
 * ```
 */
export function hkdf(ikm: Uint8Array | string, options: HkdfOptions = {}): Uint8Array {
  const ikmBytes = coerceToBytes(ikm, "ikm");
  if (ikmBytes.length === 0) {
    throw new ValidationError("ikm must not be empty");
  }
  const length = options.length ?? 32;
  const hashAlg = options.hash ?? HashAlgorithm.SHA256;
  assertInteger(length, "length", { min: 1, max: 255 * 64 });
  const salt = options.salt !== undefined ? coerceToBytes(options.salt, "salt") : new Uint8Array(0);
  const info = options.info !== undefined ? coerceToBytes(options.info, "info") : new Uint8Array(0);
  try {
    const derived = hkdfSync(hashAlg, ikmBytes, salt, info, length);
    return new Uint8Array(derived);
  } catch (cause) {
    throw new KeyDerivationError("HKDF derivation failed", { cause });
  }
}

/** Options for {@link deriveKeyFromPassword}. */
export interface ScryptOptions {
  /** Output length in bytes (default 32). */
  length?: number;
  /** CPU/memory cost parameter N (power of two, default 2^15 = 32768). */
  cost?: number;
  /** Block size parameter r (default 8). */
  blockSize?: number;
  /** Parallelization parameter p (default 1). */
  parallelization?: number;
}

/**
 * Stretch a low-entropy password into a key using scrypt (memory-hard).
 *
 * A unique random `salt` MUST be supplied per password and stored alongside the
 * output. This function is intentionally slow.
 *
 * @param password the user secret (string or bytes).
 * @param salt unique random salt (>= 16 bytes recommended).
 * @param options scrypt cost parameters — see {@link ScryptOptions}.
 * @throws {KeyDerivationError} if derivation fails (e.g. insufficient memory).
 */
export function deriveKeyFromPassword(
  password: Uint8Array | string,
  salt: Uint8Array | string,
  options: ScryptOptions = {},
): Uint8Array {
  const pwd = coerceToBytes(password, "password");
  const saltBytes = coerceToBytes(salt, "salt");
  const length = options.length ?? 32;
  const cost = options.cost ?? 32768;
  const blockSize = options.blockSize ?? 8;
  const parallelization = options.parallelization ?? 1;
  assertInteger(length, "length", { min: 1, max: 1024 });
  try {
    const derived = scryptSync(pwd, saltBytes, length, {
      N: cost,
      r: blockSize,
      p: parallelization,
      // Raise the default memory ceiling so higher cost params don't error out.
      maxmem: 256 * 1024 * 1024,
    });
    return new Uint8Array(derived);
  } catch (cause) {
    throw new KeyDerivationError("scrypt derivation failed", { cause });
  }
}

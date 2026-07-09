/**
 * @module random
 *
 * Cryptographically secure random generation, built on Node's `crypto`
 * CSPRNG (`randomBytes`, `randomUUID`, `randomInt`), which draws from the OS
 * entropy source (getrandom(2) / BCryptGenRandom). No custom RNG is implemented.
 *
 * Use these for nonces, IVs, salts, key material, and unguessable identifiers.
 * Never use `Math.random()` for any of these.
 */

import {
  randomBytes as nodeRandomBytes,
  randomUUID,
  randomInt as nodeRandomInt,
} from "node:crypto";
import { RandomGenerationError, ValidationError } from "../errors/index.js";
import { GCM_NONCE_BYTES, MAX_RANDOM_BYTES } from "../constants/index.js";
import { toBase64Url, toHex } from "../encoding/index.js";
import { assertInteger } from "../utils/index.js";

/**
 * Generate `length` cryptographically secure random bytes.
 *
 * @param length number of bytes, in `[1, MAX_RANDOM_BYTES]`.
 * @throws {ValidationError} if `length` is out of range or not an integer.
 * @throws {RandomGenerationError} if the platform CSPRNG fails.
 *
 * @example
 * ```ts
 * const salt = randomBytes(16);
 * ```
 */
export function randomBytes(length: number): Uint8Array {
  assertInteger(length, "length", { min: 1, max: MAX_RANDOM_BYTES });
  try {
    return new Uint8Array(nodeRandomBytes(length));
  } catch (cause) {
    throw new RandomGenerationError("CSPRNG failed to produce random bytes", { cause });
  }
}

/**
 * Generate a random AEAD nonce. Defaults to the 12-byte GCM nonce size.
 *
 * SECURITY: A `(key, nonce)` pair must NEVER repeat for AES-GCM. With random
 * 96-bit nonces, keep the number of messages per key well below ~2^32 to stay
 * within safe collision bounds. Future modules that need higher volumes should
 * derive per-message keys (a Module 2+ concern), not reuse a single key here.
 *
 * @param length nonce length in bytes (default {@link GCM_NONCE_BYTES}).
 */
export function generateNonce(length: number = GCM_NONCE_BYTES): Uint8Array {
  assertInteger(length, "length", { min: 1, max: 64 });
  return randomBytes(length);
}

/**
 * Alias of {@link generateNonce} for callers thinking in "IV" terms.
 * For AES-GCM the IV *is* the nonce; both default to 12 bytes.
 */
export function generateIV(length: number = GCM_NONCE_BYTES): Uint8Array {
  return generateNonce(length);
}

/**
 * Generate an unguessable identifier as URL-safe base64 (no padding).
 *
 * @param byteLength entropy in bytes (default 16 = 128 bits).
 * @example
 * ```ts
 * randomId();   // e.g. "Xa3f9Zt0Qb1cD2eF3gH4iA"
 * randomId(32); // 256 bits of entropy
 * ```
 */
export function randomId(byteLength = 16): string {
  return toBase64Url(randomBytes(byteLength));
}

/**
 * Generate an unguessable identifier as lowercase hex.
 * @param byteLength entropy in bytes (default 16 = 128 bits).
 */
export function randomHexId(byteLength = 16): string {
  return toHex(randomBytes(byteLength));
}

/**
 * Generate an RFC 4122 v4 UUID string, e.g. `"1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"`.
 */
export function uuid(): string {
  try {
    return randomUUID();
  } catch (cause) {
    throw new RandomGenerationError("CSPRNG failed to produce a UUID", { cause });
  }
}

/**
 * Generate a uniformly-distributed secure random integer in `[min, max)`.
 * (Half-open, matching Node's `crypto.randomInt`.)
 *
 * @throws {ValidationError} if the range is invalid.
 * @throws {RandomGenerationError} if the platform CSPRNG fails.
 */
export function randomInt(min: number, max: number): number {
  assertInteger(min, "min");
  assertInteger(max, "max");
  if (max <= min) {
    throw new ValidationError(`max (${max}) must be greater than min (${min})`);
  }
  try {
    return nodeRandomInt(min, max);
  } catch (cause) {
    throw new RandomGenerationError("CSPRNG failed to produce a random integer", { cause });
  }
}

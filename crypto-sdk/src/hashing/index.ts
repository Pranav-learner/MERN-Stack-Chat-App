/**
 * @module hashing
 *
 * One-way cryptographic hashing over buffers, strings, and files. Backed by
 * Node/OpenSSL `createHash`. (For constant-time digest comparison, use
 * `constantTimeEqual` from the `utils` module.)
 *
 * NOTE: These are *unkeyed* hashes for integrity/identity/fingerprinting. They
 * are NOT password hashes (use a memory-hard KDF for passwords — see the `kdf`
 * module's `deriveKeyFromPassword`) and NOT message authentication codes (an
 * AEAD cipher or HMAC provides authentication).
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { HashAlgorithm } from "../constants/index.js";
import { HashingError } from "../errors/index.js";
import { coerceToBytes } from "../utils/index.js";
import { toHex } from "../encoding/index.js";

/**
 * Hash a buffer or UTF-8 string with the given algorithm.
 *
 * @param data bytes, or a string (interpreted as UTF-8).
 * @param algorithm one of {@link HashAlgorithm} (default SHA-256).
 * @returns the raw digest bytes.
 * @throws {HashingError} if the algorithm is unavailable or hashing fails.
 *
 * @example
 * ```ts
 * const digest = hash("hello", HashAlgorithm.SHA256); // Uint8Array(32)
 * ```
 */
export function hash(
  data: Uint8Array | string,
  algorithm: HashAlgorithm = HashAlgorithm.SHA256,
): Uint8Array {
  const bytes = coerceToBytes(data, "data");
  try {
    const h = createHash(algorithm);
    h.update(bytes);
    return new Uint8Array(h.digest());
  } catch (cause) {
    throw new HashingError(`Failed to hash data with ${algorithm}`, { cause });
  }
}

/** Convenience: SHA-256 digest of `data`. */
export function sha256(data: Uint8Array | string): Uint8Array {
  return hash(data, HashAlgorithm.SHA256);
}

/** Convenience: SHA-512 digest of `data`. */
export function sha512(data: Uint8Array | string): Uint8Array {
  return hash(data, HashAlgorithm.SHA512);
}

/** Convenience: BLAKE2b-512 digest of `data`. */
export function blake2b512(data: Uint8Array | string): Uint8Array {
  return hash(data, HashAlgorithm.BLAKE2B512);
}

/**
 * Hash `data` and return the digest as a lowercase hex string.
 * @example
 * ```ts
 * hashHex("hello"); // "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
 * ```
 */
export function hashHex(
  data: Uint8Array | string,
  algorithm: HashAlgorithm = HashAlgorithm.SHA256,
): string {
  return toHex(hash(data, algorithm));
}

/**
 * Stream a file from disk through the hash function (constant memory, suitable
 * for large media files) and resolve with the raw digest.
 *
 * This is filesystem I/O only — it does NOT read, decrypt, or interpret file
 * contents beyond feeding bytes to the digest.
 *
 * @param path absolute or relative path to the file.
 * @param algorithm one of {@link HashAlgorithm} (default SHA-256).
 * @throws {HashingError} if the file cannot be read or hashed.
 *
 * @example
 * ```ts
 * const digest = await hashFile("./video.mp4", HashAlgorithm.SHA256);
 * ```
 */
export function hashFile(
  path: string,
  algorithm: HashAlgorithm = HashAlgorithm.SHA256,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let h: ReturnType<typeof createHash>;
    try {
      h = createHash(algorithm);
    } catch (cause) {
      reject(new HashingError(`Unsupported hash algorithm ${algorithm}`, { cause }));
      return;
    }
    const stream = createReadStream(path);
    stream.on("error", (cause) =>
      reject(new HashingError(`Failed to read file for hashing: ${path}`, { cause })),
    );
    stream.on("data", (chunk) => h.update(chunk));
    stream.on("end", () => resolve(new Uint8Array(h.digest())));
  });
}

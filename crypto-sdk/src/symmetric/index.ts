/**
 * @module symmetric
 *
 * Authenticated symmetric encryption using **AES-256-GCM** (an AEAD mode).
 *
 * AEAD gives confidentiality *and* integrity: any modification to the ciphertext,
 * nonce, or associated data causes {@link decrypt} to throw {@link DecryptionError}.
 * There is no "decrypt without verifying" path by design.
 *
 * Backed entirely by Node/OpenSSL `createCipheriv('aes-256-gcm', …)`.
 */

import { createCipheriv, createDecipheriv } from "node:crypto";
import { GCM_NONCE_BYTES, GCM_TAG_BYTES, SymmetricAlgorithm } from "../constants/index.js";
import {
  DecryptionError,
  EncryptionError,
  InvalidCiphertextError,
  ValidationError,
} from "../errors/index.js";
import { coerceToBytes } from "../utils/index.js";
import { generateNonce } from "../random/index.js";
import { EncryptedPayload, SymmetricKey } from "../keys/index.js";

/** Options for {@link encrypt}. */
export interface EncryptOptions {
  /**
   * Additional Authenticated Data: authenticated but NOT encrypted. Bind context
   * here (e.g. a header or identifier). The SAME value must be supplied to
   * {@link decrypt}. Not stored in the payload.
   */
  aad?: Uint8Array | string;
  /**
   * Explicit 12-byte nonce. Omit to generate a fresh random nonce (recommended).
   * SECURITY: never reuse a `(key, nonce)` pair.
   */
  nonce?: Uint8Array;
}

/** Options for {@link decrypt}. */
export interface DecryptOptions {
  /** The same AAD that was passed to {@link encrypt}, if any. */
  aad?: Uint8Array | string;
}

/** Generate a fresh random AES-256-GCM key. Alias of {@link SymmetricKey.generate}. */
export function generateKey(): SymmetricKey {
  return SymmetricKey.generate();
}

/**
 * Encrypt `plaintext` under `key` with AES-256-GCM.
 *
 * @param key a 256-bit {@link SymmetricKey}.
 * @param plaintext bytes, or a string (encoded as UTF-8).
 * @param options optional `aad` and/or explicit `nonce`.
 * @returns a self-describing {@link EncryptedPayload} (nonce + ciphertext + tag).
 * @throws {ValidationError} for an invalid explicit nonce length.
 * @throws {EncryptionError} if the underlying cipher fails.
 *
 * @example
 * ```ts
 * const key = generateKey();
 * const payload = encrypt(key, "hello", { aad: "msg-42" });
 * const wire = payload.serialize();
 * ```
 */
export function encrypt(
  key: SymmetricKey,
  plaintext: Uint8Array | string,
  options: EncryptOptions = {},
): EncryptedPayload {
  if (!(key instanceof SymmetricKey)) {
    throw new ValidationError("key must be a SymmetricKey");
  }
  const pt = coerceToBytes(plaintext, "plaintext");
  const nonce = options.nonce ?? generateNonce(GCM_NONCE_BYTES);
  if (nonce.length !== GCM_NONCE_BYTES) {
    throw new ValidationError(`nonce must be ${GCM_NONCE_BYTES} bytes, received ${nonce.length}`);
  }
  const keyBytes = key.bytes;
  try {
    const cipher = createCipheriv("aes-256-gcm", keyBytes, nonce, { authTagLength: GCM_TAG_BYTES });
    if (options.aad !== undefined) {
      cipher.setAAD(coerceToBytes(options.aad, "aad"));
    }
    const ciphertext = Buffer.concat([cipher.update(pt), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return new EncryptedPayload({
      algorithm: SymmetricAlgorithm.AES_256_GCM,
      nonce,
      ciphertext: new Uint8Array(ciphertext),
      authTag: new Uint8Array(authTag),
    });
  } catch (cause) {
    if (cause instanceof ValidationError) throw cause;
    throw new EncryptionError("AES-256-GCM encryption failed", { cause });
  } finally {
    keyBytes.fill(0);
  }
}

/**
 * Decrypt and authenticate an {@link EncryptedPayload}.
 *
 * @param key the same {@link SymmetricKey} used to encrypt.
 * @param payload the envelope produced by {@link encrypt}.
 * @param options the same `aad` supplied to {@link encrypt}, if any.
 * @returns the recovered plaintext bytes.
 * @throws {InvalidCiphertextError} if the payload is structurally invalid.
 * @throws {DecryptionError} if authentication fails — i.e. tampered ciphertext,
 *   wrong key, wrong nonce, or wrong/missing AAD. These are indistinguishable by
 *   design; treat any {@link DecryptionError} as "not authentic".
 *
 * @example
 * ```ts
 * const plaintext = decrypt(key, payload, { aad: "msg-42" });
 * const text = bytesToUtf8(plaintext);
 * ```
 */
export function decrypt(
  key: SymmetricKey,
  payload: EncryptedPayload,
  options: DecryptOptions = {},
): Uint8Array {
  if (!(key instanceof SymmetricKey)) {
    throw new ValidationError("key must be a SymmetricKey");
  }
  if (!(payload instanceof EncryptedPayload)) {
    throw new InvalidCiphertextError("payload must be an EncryptedPayload");
  }
  const nonce = payload.nonce;
  if (nonce.length !== GCM_NONCE_BYTES) {
    throw new InvalidCiphertextError(`nonce must be ${GCM_NONCE_BYTES} bytes`);
  }
  const authTag = payload.authTag;
  if (authTag.length !== GCM_TAG_BYTES) {
    throw new InvalidCiphertextError(`authentication tag must be ${GCM_TAG_BYTES} bytes`);
  }
  const keyBytes = key.bytes;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyBytes, nonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    if (options.aad !== undefined) {
      decipher.setAAD(coerceToBytes(options.aad, "aad"));
    }
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
    return new Uint8Array(plaintext);
  } catch (cause) {
    // GCM tag mismatch surfaces here as an OpenSSL "unable to authenticate data" error.
    throw new DecryptionError(
      "AES-256-GCM authentication failed: ciphertext is tampered, or the key/nonce/AAD is wrong",
      { cause },
    );
  } finally {
    keyBytes.fill(0);
  }
}

/**
 * @module secure-transport/crypto/aead
 *
 * Low-level authenticated encryption for the Secure Transport Layer, built on Node's
 * `crypto` (zero deps) — the same **AES-256-GCM** primitive as the Layer 2 Crypto SDK's
 * `SymmetricEngine`, and byte-compatible with the browser's Web Crypto (verified).
 *
 * Scheme: **AES-256-GCM with AAD-bound metadata, then encrypt-then-MAC (HMAC-SHA256)**.
 *   - GCM gives confidentiality + an authentication tag over ciphertext AND the AAD
 *     (so tampering with bound metadata breaks decryption).
 *   - An outer HMAC over `aad || iv || ciphertext || tag` (with the Sprint 3 `macKey`)
 *     is a second, independent integrity layer, verified first (constant-time) so a
 *     corrupted frame is rejected before AEAD work.
 *
 * @security Keys are `Buffer`s supplied by the caller (device-local Sprint 3 session
 * keys). This module never derives, stores, or logs keys. Plaintext buffers should be
 * disposed by the caller after use.
 */

import crypto from "node:crypto";
import { CIPHER_ALGORITHM, MAC_ALGORITHM, IV_BYTES, TAG_BYTES } from "../types.js";
import { IntegrityError, DecryptionError } from "../errors.js";

/**
 * AES-256-GCM encrypt with AAD, then HMAC the envelope.
 * @param {object} params
 * @param {Buffer} params.encryptionKey 32-byte key
 * @param {Buffer} params.macKey 32-byte key
 * @param {Buffer} params.plaintext bytes to encrypt
 * @param {Buffer} params.aad additional authenticated data (bound metadata)
 * @param {Buffer} [params.iv] 12-byte IV (random if omitted)
 * @returns {{ iv: Buffer, ciphertext: Buffer, tag: Buffer, mac: Buffer }}
 */
export function seal({ encryptionKey, macKey, plaintext, aad, iv }) {
  const nonce = iv ?? crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, encryptionKey, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const mac = hmac(macKey, aad, nonce, ciphertext, tag);
  return { iv: nonce, ciphertext, tag, mac };
}

/**
 * Verify the HMAC + AES-256-GCM tag, then decrypt.
 * @param {object} params
 * @param {Buffer} params.encryptionKey @param {Buffer} params.macKey
 * @param {Buffer} params.iv @param {Buffer} params.ciphertext @param {Buffer} params.tag @param {Buffer} params.mac
 * @param {Buffer} params.aad
 * @returns {Buffer} the plaintext
 * @throws {IntegrityError} if the HMAC or AEAD tag is invalid (corrupted/tampered/wrong key)
 * @throws {DecryptionError} on any other decryption failure
 */
export function open({ encryptionKey, macKey, iv, ciphertext, tag, aad }) {
  // 1. Outer integrity (encrypt-then-MAC) — constant-time, fail fast.
  const expectedMac = hmac(macKey, aad, iv, ciphertext, tag);
  const givenMac = arguments[0].mac;
  if (!Buffer.isBuffer(givenMac) || givenMac.length !== expectedMac.length || !crypto.timingSafeEqual(givenMac, expectedMac)) {
    throw new IntegrityError("MAC verification failed", { details: { layer: "hmac" } });
  }
  // 2. AEAD decrypt (also authenticates ciphertext + AAD via the GCM tag).
  try {
    const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, encryptionKey, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    // A bad GCM tag (wrong key/tampered ciphertext) throws here.
    throw new IntegrityError("AEAD tag verification failed", { cause: error, details: { layer: "gcm" } });
  }
}

/** HMAC-SHA256 over the ordered envelope parts. */
function hmac(macKey, aad, iv, ciphertext, tag) {
  return crypto.createHmac("sha256", macKey).update(aad).update(iv).update(ciphertext).update(tag).digest();
}

export { CIPHER_ALGORITHM, MAC_ALGORITHM, IV_BYTES, TAG_BYTES, DecryptionError };

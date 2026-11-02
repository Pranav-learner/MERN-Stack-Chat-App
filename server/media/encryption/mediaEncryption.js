/**
 * @module media/encryption/mediaEncryption
 *
 * Device-local AES-256-GCM encryption, key derivation, and integrity verification for Layer 11.
 */

import crypto from "node:crypto";
import { MediaIntegrityError } from "../errors.js";

/** Generate a 32-byte cryptographically secure random media key. @returns {Buffer} */
export function generateMediaKey() {
  return crypto.randomBytes(32);
}

/** Compute SHA-256 hex digest. @param {Buffer|string} data @returns {string} */
export function sha256(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Compute public fingerprint for a media key. @param {Buffer|string} key @returns {string} */
export function mediaKeyFingerprint(key) {
  return sha256(key);
}

/**
 * Encrypt a plaintext buffer with AES-256-GCM.
 * @param {Buffer|Uint8Array|string} plaintext
 * @param {Buffer} key 32-byte key
 * @returns {{ ciphertext: Buffer, iv: Buffer, authTag: Buffer, plaintextHash: string }}
 */
export function encryptMedia(plaintext, key) {
  const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(pt), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const plaintextHash = sha256(pt);
  return { ciphertext, iv, authTag, plaintextHash };
}

/**
 * Decrypt a ciphertext payload with AES-256-GCM.
 * @param {{ ciphertext: Buffer|string, iv: Buffer|string, authTag: Buffer|string }} enc
 * @param {Buffer} key 32-byte key
 * @returns {Buffer} decrypted plaintext
 */
export function decryptMedia(enc, key) {
  try {
    const ciphertext = Buffer.isBuffer(enc.ciphertext)
      ? enc.ciphertext
      : Buffer.from(enc.ciphertext, typeof enc.ciphertext === "string" && enc.ciphertext.length % 4 === 0 && !/[^a-zA-Z0-9+/=]/.test(enc.ciphertext) ? "base64" : "hex");
    const iv = Buffer.isBuffer(enc.iv) ? enc.iv : Buffer.from(enc.iv, "base64");
    const authTag = Buffer.isBuffer(enc.authTag) ? enc.authTag : Buffer.from(enc.authTag, "base64");

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new MediaIntegrityError("Failed to decrypt media: integrity tag mismatch or corrupted ciphertext", {
      details: { original: err.message },
    });
  }
}

/**
 * @module identity/fingerprints
 *
 * Deterministic identity/device fingerprints. A fingerprint is a stable,
 * collision-resistant summary of a **public key** — safe to display and compare.
 *
 * ## Specification (shared with the client & the Crypto SDK)
 * `fingerprint = SHA-256(rawPublicKeyBytes)` where `rawPublicKeyBytes` is the raw
 * 32-byte Ed25519 public key. The canonical ("machine") form is the lowercase hex
 * digest (64 chars). This is byte-for-byte identical to the Crypto SDK's
 * `fingerprint()` (`crypto-engine`), so client and server always agree.
 *
 * Because the fingerprint is a function of the identity public key only, it is
 * **stable across devices** for the same identity (each device has its own device
 * fingerprint, but the identity fingerprint is shared).
 *
 * Formats provided:
 * - **machine** — lowercase hex (canonical).
 * - **human** — hex grouped into short blocks for eyeballing.
 * - **binary** — the raw 32-byte digest (`Buffer`).
 * - **numeric code** — a fixed-width digit string (safety-number-style display;
 *   pairwise safety numbers combining two identities are a future concern).
 */

import crypto from "node:crypto";

/** Hash algorithm used for fingerprints. */
export const FINGERPRINT_ALGORITHM = "sha256";

/**
 * SHA-256 digest of the given bytes.
 * @param {Uint8Array | Buffer} bytes
 * @returns {Buffer} 32-byte digest
 */
export function sha256(bytes) {
  return crypto.createHash(FINGERPRINT_ALGORITHM).update(bytes).digest();
}

/**
 * Compute the canonical (machine) fingerprint: hex SHA-256 of the raw public key.
 * @param {Uint8Array | Buffer} publicKeyBytes raw public key bytes
 * @returns {string} 64-char lowercase hex
 * @example
 * computeFingerprint(rawEd25519PublicKey); // "9f86d081884c7d65..."
 */
export function computeFingerprint(publicKeyBytes) {
  return sha256(publicKeyBytes).toString("hex");
}

/**
 * The binary fingerprint (raw 32-byte digest).
 * @param {Uint8Array | Buffer} publicKeyBytes
 * @returns {Buffer}
 */
export function fingerprintBinary(publicKeyBytes) {
  return sha256(publicKeyBytes);
}

/**
 * Human-readable fingerprint: hex grouped into `groupSize`-char blocks.
 * @param {string} fingerprintHex canonical hex fingerprint
 * @param {number} [groupSize=4]
 * @returns {string} e.g. `"9f86 d081 884c 7d65 ..."`
 */
export function toHumanReadable(fingerprintHex, groupSize = 4) {
  const groups = fingerprintHex.match(new RegExp(`.{1,${groupSize}}`, "g"));
  return groups ? groups.join(" ") : fingerprintHex;
}

/**
 * A fixed-width numeric code derived from the fingerprint — a safety-number-style
 * display value. Deterministic: reads the digest as eight big-endian uint32s,
 * each reduced to a zero-padded 5-digit group (40 digits total).
 *
 * NOTE: This is a single-identity display code. Pairwise "safety numbers" that
 * combine two users' identities for mutual verification are a FUTURE layer.
 *
 * @param {string} fingerprintHex canonical hex fingerprint
 * @returns {string} e.g. `"48213 90551 ... "` (8 groups of 5 digits)
 */
export function toNumericCode(fingerprintHex) {
  const digest = Buffer.from(fingerprintHex, "hex");
  const groups = [];
  for (let i = 0; i + 4 <= digest.length && groups.length < 8; i += 4) {
    const value = digest.readUInt32BE(i) % 100000;
    groups.push(String(value).padStart(5, "0"));
  }
  return groups.join(" ");
}

/**
 * Constant-time verification that `claimedHex` is the correct fingerprint of
 * `publicKeyBytes`. Returns `false` (never throws) on any mismatch or malformed
 * input.
 * @param {Uint8Array | Buffer} publicKeyBytes
 * @param {string} claimedHex
 * @returns {boolean}
 */
export function verifyFingerprint(publicKeyBytes, claimedHex) {
  if (typeof claimedHex !== "string" || !/^[0-9a-f]{64}$/i.test(claimedHex)) return false;
  const actual = sha256(publicKeyBytes);
  const claimed = Buffer.from(claimedHex, "hex");
  if (actual.length !== claimed.length) return false;
  return crypto.timingSafeEqual(actual, claimed);
}

/**
 * Produce every display format for a canonical fingerprint at once.
 * @param {string} fingerprintHex
 * @returns {{ machine: string, human: string, numeric: string }}
 */
export function fingerprintFormats(fingerprintHex) {
  return {
    machine: fingerprintHex,
    human: toHumanReadable(fingerprintHex),
    numeric: toNumericCode(fingerprintHex),
  };
}

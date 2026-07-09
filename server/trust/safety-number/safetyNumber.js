/**
 * @module trust/safety-number
 *
 * Deterministic, symmetric **safety numbers** for out-of-band identity
 * verification between two users — the same 60-digit number is computed by both
 * parties from their two public identity keys, so they can compare it in person /
 * over a call / via QR (Signal-style numeric fingerprint).
 *
 * ## Construction (version 1)
 * For each participant `i` a per-party digest is computed by iterated hashing:
 *   `d_i = H^N( version || publicKey_i || identifier_i , publicKey_i )` (first 30 bytes)
 * where `H` is SHA-512 and `N` is the iteration count. Each 30-byte digest encodes
 * to a 30-digit string (6 groups of 5 digits, each `5-byte-BE mod 100000`). The
 * safety number is the two 30-digit strings concatenated in a **canonical order**
 * (by digest byte comparison), giving an identical value for both parties.
 *
 * @security Derived entirely from PUBLIC keys — not secret. Its job is a stable,
 * collision-resistant, human-comparable representation, not confidentiality.
 */

import crypto from "node:crypto";

/** Safety-number scheme version. */
export const SAFETY_NUMBER_VERSION = 1;

/** Default hash iteration count (mild brute-force hardening for the display value). */
export const DEFAULT_ITERATIONS = 5200;

/** Digits produced per party. */
const DIGITS_PER_PARTY = 30;
/** Bytes consumed from the digest (6 chunks × 5 bytes → 30 digits). */
const DIGEST_BYTES = 30;

function versionBytes(version) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(version & 0xffff, 0);
  return b;
}

/** Iterated per-party digest (first {@link DIGEST_BYTES} bytes). */
function partyDigest(publicKey, identifier, version, iterations) {
  let hash = Buffer.concat([versionBytes(version), Buffer.from(publicKey), Buffer.from(identifier, "utf8")]);
  const key = Buffer.from(publicKey);
  for (let i = 0; i < iterations; i++) {
    hash = crypto.createHash("sha512").update(hash).update(key).digest();
  }
  return hash.subarray(0, DIGEST_BYTES);
}

/** Encode a 30-byte digest as a 30-digit string. */
function digestToDigits(digest) {
  let out = "";
  for (let i = 0; i + 5 <= digest.length; i += 5) {
    // 5 bytes → 40-bit big-endian integer → mod 100000 → 5 digits.
    let value = 0;
    for (let j = 0; j < 5; j++) value = value * 256 + digest[i + j];
    out += String(value % 100000).padStart(5, "0");
  }
  return out; // 30 digits
}

/**
 * Compute the deterministic, symmetric safety number for two identities.
 *
 * @param {{ publicKey: Uint8Array|Buffer, identifier: string }} a party A
 * @param {{ publicKey: Uint8Array|Buffer, identifier: string }} b party B
 * @param {{ version?: number, iterations?: number }} [options]
 * @returns {{ version: number, value: string, formatted: string }}
 * @example
 * const sn = computeSafetyNumber(
 *   { publicKey: aKeyBytes, identifier: "userA" },
 *   { publicKey: bKeyBytes, identifier: "userB" },
 * );
 * sn.value;     // "01234567890123456789012345678901234567890123456789012345678"  (60 digits)
 * sn.formatted; // "01234 56789 01234 ..." (12 groups of 5)
 */
export function computeSafetyNumber(a, b, options = {}) {
  const version = options.version ?? SAFETY_NUMBER_VERSION;
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const da = partyDigest(a.publicKey, a.identifier, version, iterations);
  const db = partyDigest(b.publicKey, b.identifier, version, iterations);
  // Canonical order so both parties derive the same string.
  const [first, second] = Buffer.compare(da, db) <= 0 ? [da, db] : [db, da];
  const value = digestToDigits(first) + digestToDigits(second); // 60 digits
  return { version, value, formatted: formatSafetyNumber(value) };
}

/** Format a raw safety-number string into groups of 5 for display. */
export function formatSafetyNumber(value) {
  const groups = value.match(/.{1,5}/g);
  return groups ? groups.join(" ") : value;
}

/** Normalize a user-entered safety number (strip whitespace) for comparison. */
export function normalizeSafetyNumber(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "") : "";
}

/**
 * Validate a safety-number string's shape (60 digits, ignoring whitespace).
 * @param {string} value
 * @returns {boolean}
 */
export function isValidSafetyNumber(value) {
  return /^\d{60}$/.test(normalizeSafetyNumber(value));
}

/** Constant-length count of digits per party (for callers/tests). */
export const SAFETY_NUMBER_DIGITS = DIGITS_PER_PARTY * 2;

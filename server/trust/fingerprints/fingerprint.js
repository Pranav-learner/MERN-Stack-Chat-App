/**
 * @module trust/fingerprints
 *
 * Rich identity fingerprints for the trust layer. Builds on the Sprint 1
 * fingerprint (`SHA-256(rawPublicKey)` hex) — reusing it so client, identity, and
 * trust all agree — and exposes the compact / human / machine / versioned forms
 * plus metadata.
 *
 * A fingerprint is a deterministic function of the identity public key, so it is
 * stable unless the identity's key changes (which is exactly what the trust layer
 * detects).
 *
 * @security Fingerprints are derived from PUBLIC keys and are safe to display.
 */

import {
  computeFingerprint,
  toHumanReadable,
  verifyFingerprint as verifyMachineFingerprint,
} from "../../identity/fingerprints/fingerprint.js";

/** Fingerprint scheme version. */
export const FINGERPRINT_VERSION = 1;

/** Length (hex chars) of the compact fingerprint. */
export const COMPACT_LENGTH = 16;

/**
 * @typedef {object} Fingerprint
 * @property {number} version scheme version
 * @property {string} machine full 64-char hex (canonical, stable)
 * @property {string} compact short prefix for compact display / lookups
 * @property {string} human hex grouped for eyeballing
 * @property {string} algorithm key algorithm
 * @property {{ algorithm: string, version: number, createdAt?: string }} metadata
 */

/**
 * Build a rich {@link Fingerprint} from raw public-key bytes.
 * @param {Uint8Array|Buffer} publicKeyBytes raw public key
 * @param {{ algorithm?: string, createdAt?: string }} [options]
 * @returns {Fingerprint}
 * @example
 * const fp = buildFingerprint(rawEd25519PublicKey, { algorithm: "ed25519" });
 * fp.machine; // "9f86d081..."; fp.compact; // "9f86d081884c7d65"
 */
export function buildFingerprint(publicKeyBytes, options = {}) {
  const machine = computeFingerprint(publicKeyBytes);
  const algorithm = options.algorithm ?? "ed25519";
  const metadata = { algorithm, version: FINGERPRINT_VERSION };
  if (options.createdAt) metadata.createdAt = options.createdAt;
  return {
    version: FINGERPRINT_VERSION,
    machine,
    compact: machine.slice(0, COMPACT_LENGTH),
    human: toHumanReadable(machine),
    algorithm,
    metadata,
  };
}

/**
 * Verify that a claimed machine fingerprint matches the given public key
 * (constant-time; delegates to the Sprint 1 verifier).
 * @param {Uint8Array|Buffer} publicKeyBytes
 * @param {string} claimedMachineHex
 * @returns {boolean}
 */
export function verifyFingerprint(publicKeyBytes, claimedMachineHex) {
  return verifyMachineFingerprint(publicKeyBytes, claimedMachineHex);
}

/**
 * Whether two fingerprints (machine hex) are equal.
 * @param {string} a @param {string} b @returns {boolean}
 */
export function fingerprintsEqual(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

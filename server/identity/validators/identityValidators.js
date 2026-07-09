/**
 * @module identity/validators
 *
 * Validation of identity/device submissions arriving from clients. The server
 * only ever receives **public** material; these validators enforce that it is
 * well-formed and that the client-supplied fingerprint actually matches the key.
 *
 * Detects: corrupted/oversized/undersized public keys, invalid curve points,
 * unsupported algorithms, and fingerprint mismatches.
 */

import crypto from "node:crypto";
import { IdentityValidationError } from "../errors.js";
import { verifyFingerprint } from "../fingerprints/fingerprint.js";

/** Algorithms accepted for identity/device keys (Ed25519 only in Sprint 1). */
export const SUPPORTED_ALGORITHMS = Object.freeze(["ed25519"]);

/** Raw Ed25519 public-key length in bytes. */
export const ED25519_PUBLIC_KEY_BYTES = 32;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode and length-check a base64 raw public key.
 * @param {string} publicKeyB64
 * @returns {Buffer} the 32 raw key bytes
 * @throws {IdentityValidationError}
 */
export function decodePublicKey(publicKeyB64) {
  if (typeof publicKeyB64 !== "string" || publicKeyB64.length === 0 || !BASE64_RE.test(publicKeyB64)) {
    throw new IdentityValidationError("publicKey must be a non-empty base64 string");
  }
  const bytes = Buffer.from(publicKeyB64, "base64");
  if (bytes.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new IdentityValidationError(
      `Ed25519 public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

/**
 * Assert the raw bytes form a valid Ed25519 public key by importing them as a
 * KeyObject (rejects non-canonical / corrupt encodings).
 * @param {Buffer} bytes
 * @throws {IdentityValidationError}
 */
export function assertValidEd25519PublicKey(bytes) {
  try {
    crypto.createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: bytes.toString("base64url") },
      format: "jwk",
    });
  } catch (cause) {
    throw new IdentityValidationError("Corrupted or invalid Ed25519 public key", { cause });
  }
}

/**
 * Full validation of a public-key submission: algorithm, encoding, curve
 * validity, and fingerprint consistency.
 *
 * @param {{ publicKey: string, algorithm: string, fingerprint: string }} submission
 * @returns {Buffer} the validated raw public-key bytes
 * @throws {IdentityValidationError}
 * @example
 * const bytes = validatePublicKeySubmission({ publicKey, algorithm: "ed25519", fingerprint });
 */
export function validatePublicKeySubmission(submission) {
  const { publicKey, algorithm, fingerprint } = submission ?? {};
  if (!SUPPORTED_ALGORITHMS.includes(algorithm)) {
    throw new IdentityValidationError(
      `Unsupported algorithm: ${algorithm}. Supported: ${SUPPORTED_ALGORITHMS.join(", ")}`,
    );
  }
  const bytes = decodePublicKey(publicKey);
  assertValidEd25519PublicKey(bytes);
  if (!verifyFingerprint(bytes, fingerprint)) {
    throw new IdentityValidationError("Fingerprint does not match the provided public key");
  }
  return bytes;
}

/**
 * Validate a device descriptor's non-key fields.
 * @param {{ deviceId: string, name?: string, platform?: string }} device
 * @throws {IdentityValidationError}
 */
export function validateDeviceDescriptor(device) {
  if (!device || typeof device !== "object") {
    throw new IdentityValidationError("device descriptor is required");
  }
  if (typeof device.deviceId !== "string" || device.deviceId.length < 8) {
    throw new IdentityValidationError("deviceId must be a stable string of length >= 8");
  }
  if (device.name !== undefined && typeof device.name !== "string") {
    throw new IdentityValidationError("device.name must be a string");
  }
  if (device.platform !== undefined && typeof device.platform !== "string") {
    throw new IdentityValidationError("device.platform must be a string");
  }
}

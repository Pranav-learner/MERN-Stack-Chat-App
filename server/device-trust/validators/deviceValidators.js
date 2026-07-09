/**
 * @module device-trust/validators
 *
 * Validation for device registration submissions. Reuses the Sprint 1 identity
 * validators for public-key + fingerprint checks (building on top, not
 * re-implementing), and adds device-metadata validation.
 */

import { validatePublicKeySubmission } from "../../identity/validators/identityValidators.js";
import { DeviceValidationError } from "../errors.js";
import { DeviceCapability } from "../types.js";

const KNOWN_CAPABILITIES = new Set(Object.values(DeviceCapability));

/**
 * Validate the full device registration submission.
 *
 * @param {{ deviceId: string, publicKey: string, algorithm: string, fingerprint: string,
 *           name?: string, platform?: string, os?: string, appVersion?: string,
 *           capabilities?: string[], metadata?: object }} submission
 * @returns {Buffer} validated raw public-key bytes
 * @throws {DeviceValidationError}
 * @example
 * const bytes = validateDeviceSubmission({ deviceId, publicKey, algorithm: "ed25519", fingerprint });
 */
export function validateDeviceSubmission(submission) {
  const sub = submission ?? {};
  if (typeof sub.deviceId !== "string" || sub.deviceId.length < 8) {
    throw new DeviceValidationError("deviceId must be a stable string of length >= 8");
  }
  // Reuse Sprint 1: validates key format, curve validity, and fingerprint match.
  let bytes;
  try {
    bytes = validatePublicKeySubmission({
      publicKey: sub.publicKey,
      algorithm: sub.algorithm,
      fingerprint: sub.fingerprint,
    });
  } catch (cause) {
    // Re-wrap identity validation error into a device-trust error (keeps status 400).
    throw new DeviceValidationError(cause.message, { cause });
  }
  validateOptionalStrings(sub);
  validateCapabilities(sub.capabilities);
  validateMetadata(sub.metadata);
  return bytes;
}

/**
 * Validate an updatable metadata patch (rename / metadata update).
 * @param {object} [metadata]
 * @throws {DeviceValidationError}
 */
export function validateMetadata(metadata) {
  if (metadata === undefined) return;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new DeviceValidationError("metadata must be a plain object");
  }
  try {
    JSON.stringify(metadata);
  } catch (cause) {
    throw new DeviceValidationError("metadata must be JSON-serializable", { cause });
  }
}

/**
 * Validate declared capabilities.
 * @param {string[]} [capabilities]
 * @throws {DeviceValidationError}
 */
export function validateCapabilities(capabilities) {
  if (capabilities === undefined) return;
  if (!Array.isArray(capabilities)) {
    throw new DeviceValidationError("capabilities must be an array of strings");
  }
  for (const cap of capabilities) {
    if (typeof cap !== "string" || !KNOWN_CAPABILITIES.has(cap)) {
      throw new DeviceValidationError(`Unknown capability: ${cap}`);
    }
  }
}

function validateOptionalStrings(sub) {
  for (const field of ["name", "platform", "os", "appVersion"]) {
    if (sub[field] !== undefined && typeof sub[field] !== "string") {
      throw new DeviceValidationError(`device.${field} must be a string`);
    }
  }
}

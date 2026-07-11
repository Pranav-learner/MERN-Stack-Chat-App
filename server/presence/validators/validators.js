/**
 * @module presence/validators
 *
 * Validation for the Presence Service. Covers every spec item: duplicate registrations,
 * heartbeat timeout, expired devices, unknown devices, invalid transitions, malformed
 * metadata, and unauthorized updates. Status-transition validation itself lives in
 * {@link module:presence/lifecycle}; this module covers the rest and — most importantly —
 * enforces the framework's core invariant:
 *
 * @security A presence record or advertisement must NEVER carry secret material: no private
 * key, session key, message key, chain key, root key, MAC key, or shared secret.
 * {@link assertNoSecretMaterial} deep-scans for forbidden keys and is invoked before anything
 * is stored or returned.
 */

import { ALL_PRESENCE_STATUSES, USER_SETTABLE_STATUSES } from "../types/types.js";
import {
  PresenceValidationError,
  PresenceNotFoundError,
  PresenceExpiredError,
  UnauthorizedPresenceError,
  DuplicatePresenceError,
  CorruptedPresenceError,
} from "../errors.js";

const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const PRESENCE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Field names that must NEVER appear anywhere in a presence record/advertisement. */
export const FORBIDDEN_SECRET_KEYS = Object.freeze([
  "privateKey",
  "secretKey",
  "sharedSecret",
  "sessionKey",
  "encryptionKey",
  "macKey",
  "messageKey",
  "chainKey",
  "rootKey",
  "ratchetKey",
  "keyBytes",
  "seed",
  "privateBytes",
]);

/** Validate a presence-id's shape. @throws {PresenceValidationError} */
export function validatePresenceId(presenceId) {
  if (typeof presenceId !== "string" || !PRESENCE_ID_RE.test(presenceId)) {
    throw new PresenceValidationError("Invalid presence identifier", { details: { presenceId } });
  }
  return presenceId;
}

/** Validate a user-id reference. @throws {PresenceValidationError} */
export function validateUserRef(userId) {
  if (userId == null || typeof userId !== "string" || !USER_ID_RE.test(userId)) {
    throw new PresenceValidationError("Invalid user identifier", { details: { userId } });
  }
  return userId;
}

/** Validate a device-id reference. @throws {PresenceValidationError} */
export function validateDeviceRef(deviceId) {
  if (deviceId == null || typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
    throw new PresenceValidationError("Invalid device identifier", { details: { deviceId } });
  }
  return deviceId;
}

/** Validate a presence status is known. @throws {PresenceValidationError} */
export function validateStatus(status) {
  if (!ALL_PRESENCE_STATUSES.includes(status)) {
    throw new PresenceValidationError(`Unknown presence status "${status}"`, { details: { status } });
  }
  return status;
}

/** Validate a status is one a USER may explicitly set (not a system-only status). */
export function validateUserSettableStatus(status) {
  if (!USER_SETTABLE_STATUSES.includes(status)) {
    throw new PresenceValidationError(`Status "${status}" is not user-settable`, {
      details: { status, allowed: [...USER_SETTABLE_STATUSES] },
    });
  }
  return status;
}

/**
 * Validate a presence registration/update request payload before it reaches the manager.
 * @param {object} request @param {{ requireStatus?: boolean }} [options]
 * @returns {object} the (unmodified) request @throws {PresenceValidationError}
 */
export function validateRegistrationRequest(request, options = {}) {
  if (!request || typeof request !== "object") {
    throw new PresenceValidationError("Malformed presence request");
  }
  validateUserRef(request.userId);
  validateDeviceRef(request.deviceId);
  if (request.identityId !== undefined && request.identityId !== null && typeof request.identityId !== "string") {
    throw new PresenceValidationError("identityId must be a string", { details: { identityId: request.identityId } });
  }
  if (options.requireStatus || request.status !== undefined) validateStatus(request.status);
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) {
    throw new PresenceValidationError("timeoutMs must be a positive number", { details: { timeoutMs: request.timeoutMs } });
  }
  if (request.metadata !== undefined && (typeof request.metadata !== "object" || request.metadata === null || Array.isArray(request.metadata))) {
    throw new PresenceValidationError("metadata must be a plain object", { details: { metadata: request.metadata } });
  }
  return request;
}

/** Require a presence record to exist. @throws {PresenceNotFoundError} */
export function requirePresence(record, ref) {
  if (!record) throw new PresenceNotFoundError("Presence record not found", { details: { ref } });
  return record;
}

/**
 * Assert a record has not expired (heartbeat timeout). Pure check — the caller decides whether
 * to transition it to EXPIRED. @throws {PresenceExpiredError}
 * @param {import("../types/types.js").PresenceRecord} record @param {number} [now]
 */
export function assertNotExpired(record, now = Date.now()) {
  if (record?.expiresAt && new Date(record.expiresAt).getTime() <= now && record.status !== "expired") {
    throw new PresenceExpiredError("Presence has expired (heartbeat timeout)", {
      details: { presenceId: record.presenceId, expiresAt: record.expiresAt },
    });
  }
  return record;
}

/**
 * Assert the acting user owns a presence record (only its owner may update/inspect it).
 * @param {import("../types/types.js").PresenceRecord} record @param {string} actingUserId
 * @throws {UnauthorizedPresenceError}
 */
export function assertOwner(record, actingUserId) {
  if (!actingUserId || String(record.userId) !== String(actingUserId)) {
    throw new UnauthorizedPresenceError("Caller does not own this presence record", {
      details: { presenceId: record.presenceId },
    });
  }
  return record;
}

/**
 * Assert a registration does not duplicate an existing REACHABLE presence for the same device.
 * A re-registration of an offline/expired device is allowed (it revives the record).
 * @param {import("../types/types.js").PresenceRecord|null} existing
 * @param {boolean} existingReachable whether the existing record is currently reachable
 * @throws {DuplicatePresenceError}
 */
export function assertNoDuplicateRegistration(existing, existingReachable) {
  if (existing && existingReachable) {
    throw new DuplicatePresenceError("Presence already registered + reachable for this device", {
      details: { presenceId: existing.presenceId, deviceId: existing.deviceId },
    });
  }
}

/**
 * Deep-scan an object graph for forbidden secret key material. The framework's core security
 * invariant. @param {any} value @param {string} [label] @throws {CorruptedPresenceError}
 */
export function assertNoSecretMaterial(value, label = "presence record") {
  const seen = new Set();
  const walk = (node, path) => {
    if (node == null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    for (const key of Object.keys(node)) {
      if (FORBIDDEN_SECRET_KEYS.includes(key)) {
        throw new CorruptedPresenceError(`${label} must not contain secret material ("${key}")`, {
          details: { key, path: `${path}.${key}` },
        });
      }
      walk(node[key], `${path}.${key}`);
    }
  };
  walk(value, label);
  return value;
}

/**
 * Validate a device advertisement's shape (detects corruption/tampering + secret leakage).
 * @param {object} advertisement @throws {CorruptedPresenceError}
 */
export function validateAdvertisement(advertisement) {
  if (!advertisement || typeof advertisement !== "object") {
    throw new CorruptedPresenceError("Device advertisement is not an object");
  }
  for (const field of ["userId", "deviceId", "status"]) {
    if (advertisement[field] === undefined || advertisement[field] === null) {
      throw new CorruptedPresenceError(`Device advertisement is missing "${field}"`, { details: { field } });
    }
  }
  if (!ALL_PRESENCE_STATUSES.includes(advertisement.status)) {
    throw new CorruptedPresenceError(`Advertisement has unknown status: ${advertisement.status}`, { details: { status: advertisement.status } });
  }
  assertNoSecretMaterial(advertisement, "device advertisement");
  return advertisement;
}

/**
 * Validate a presence record's stored shape.
 * @param {object} record @throws {CorruptedPresenceError}
 */
export function validatePresenceRecord(record) {
  if (!record || typeof record !== "object") {
    throw new CorruptedPresenceError("Presence record is not an object");
  }
  for (const field of ["presenceId", "userId", "deviceId", "status"]) {
    if (record[field] === undefined || record[field] === null) {
      throw new CorruptedPresenceError(`Presence record is missing "${field}"`, { details: { field } });
    }
  }
  if (!ALL_PRESENCE_STATUSES.includes(record.status)) {
    throw new CorruptedPresenceError(`Unknown presence status: ${record.status}`, { details: { status: record.status } });
  }
  if (record.advertisement) validateAdvertisement(record.advertisement);
  assertNoSecretMaterial(record, "presence record");
  return record;
}

/**
 * Validate a repository implements the required presence-store contract.
 * @param {object} repo @param {string[]} [methods] @throws {PresenceValidationError}
 */
export function validatePresenceRepository(
  repo,
  methods = [
    "upsert",
    "create",
    "findById",
    "findByUserAndDevice",
    "findByUser",
    "update",
    "delete",
    "listByStatus",
    "listReachableByUser",
    "listExpired",
    "countByStatus",
  ],
) {
  if (!repo || typeof repo !== "object") {
    throw new PresenceValidationError("Presence repository is missing or malformed");
  }
  for (const m of methods) {
    if (typeof repo[m] !== "function") {
      throw new PresenceValidationError(`Presence repository is missing method "${m}"`, { details: { method: m } });
    }
  }
  return repo;
}

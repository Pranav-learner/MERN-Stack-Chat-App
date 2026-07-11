/**
 * @module capabilities/validators
 *
 * Validation for the Capability Exchange subsystem. Covers every spec item: unknown protocol
 * version, unsupported crypto version, transport conflicts, invalid feature flags, malformed
 * metadata, duplicate registration, negotiation failures, and capability expiration. It also
 * enforces the framework's core invariant:
 *
 * @security A capability set must NEVER carry secret material: no private key, session key,
 * message key, chain key, root key, MAC key, or shared secret. {@link assertNoSecretMaterial}
 * deep-scans for forbidden keys and is invoked before anything is stored or returned.
 */

import {
  ALL_CAPABILITY_STATES,
  ALL_TRANSPORT_TYPES,
  ALL_COMPRESSION_TYPES,
} from "../types/types.js";
import { isValidVersion } from "../version/version.js";
import {
  CapabilityValidationError,
  CapabilityNotFoundError,
  CapabilityExpiredError,
  UnauthorizedCapabilityError,
  DuplicateCapabilityError,
  CorruptedCapabilityError,
} from "../errors.js";

const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const CAPABILITY_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Field names that must NEVER appear anywhere in a capability record. */
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

/** Validate a capability-id's shape. @throws {CapabilityValidationError} */
export function validateCapabilityId(capabilityId) {
  if (typeof capabilityId !== "string" || !CAPABILITY_ID_RE.test(capabilityId)) {
    throw new CapabilityValidationError("Invalid capability identifier", { details: { capabilityId } });
  }
  return capabilityId;
}

/** Validate a user-id reference. @throws {CapabilityValidationError} */
export function validateUserRef(userId) {
  if (userId == null || typeof userId !== "string" || !USER_ID_RE.test(userId)) {
    throw new CapabilityValidationError("Invalid user identifier", { details: { userId } });
  }
  return userId;
}

/** Validate a device-id reference. @throws {CapabilityValidationError} */
export function validateDeviceRef(deviceId) {
  if (deviceId == null || typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
    throw new CapabilityValidationError("Invalid device identifier", { details: { deviceId } });
  }
  return deviceId;
}

/** Validate a list of versions is well-formed + non-empty. @throws {CapabilityValidationError} */
export function validateVersionList(versions, label) {
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new CapabilityValidationError(`${label} must be a non-empty array`, { details: { versions } });
  }
  const bad = versions.find((v) => !isValidVersion(v));
  if (bad !== undefined) {
    throw new CapabilityValidationError(`${label} contains an invalid version "${bad}"`, { details: { bad } });
  }
  return versions;
}

/** Validate declared transports are known + non-empty. @throws {CapabilityValidationError} */
export function validateTransports(transports) {
  if (!Array.isArray(transports) || transports.length === 0) {
    throw new CapabilityValidationError("transports must be a non-empty array", { details: { transports } });
  }
  const known = new Set(ALL_TRANSPORT_TYPES);
  const bad = transports.find((t) => !known.has(t));
  if (bad !== undefined) {
    throw new CapabilityValidationError(`Unknown transport "${bad}"`, { details: { bad, known: [...known] } });
  }
  return transports;
}

/** Validate declared compression algorithms are known. @throws {CapabilityValidationError} */
export function validateCompression(compression) {
  if (compression === undefined) return compression;
  if (!Array.isArray(compression)) {
    throw new CapabilityValidationError("compression must be an array", { details: { compression } });
  }
  const known = new Set(ALL_COMPRESSION_TYPES);
  const bad = compression.find((c) => !known.has(c));
  if (bad !== undefined) {
    throw new CapabilityValidationError(`Unknown compression "${bad}"`, { details: { bad } });
  }
  return compression;
}

/** Validate feature flags are a `{ [name]: boolean }` map. @throws {CapabilityValidationError} */
export function validateFeatureFlags(featureFlags) {
  if (featureFlags === undefined) return featureFlags;
  if (typeof featureFlags !== "object" || featureFlags === null || Array.isArray(featureFlags)) {
    throw new CapabilityValidationError("featureFlags must be a plain object", { details: { featureFlags } });
  }
  for (const [flag, value] of Object.entries(featureFlags)) {
    if (typeof value !== "boolean") {
      throw new CapabilityValidationError(`Feature flag "${flag}" must be a boolean`, { details: { flag, value } });
    }
  }
  return featureFlags;
}

/**
 * Validate a raw capability registration/update request before it reaches the manager.
 * @param {object} request @param {{ requireVersions?: boolean }} [options]
 * @returns {object} the (unmodified) request @throws {CapabilityValidationError}
 */
export function validateCapabilityRequest(request, options = {}) {
  if (!request || typeof request !== "object") {
    throw new CapabilityValidationError("Malformed capability request");
  }
  validateUserRef(request.userId);
  validateDeviceRef(request.deviceId);
  if (options.requireVersions || request.protocolVersions !== undefined) validateVersionList(request.protocolVersions, "protocolVersions");
  if (options.requireVersions || request.cryptoVersions !== undefined) validateVersionList(request.cryptoVersions, "cryptoVersions");
  if (request.transports !== undefined) validateTransports(request.transports);
  validateCompression(request.compression);
  validateFeatureFlags(request.featureFlags);
  if (request.maxPayloadSize !== undefined && (!Number.isFinite(request.maxPayloadSize) || request.maxPayloadSize <= 0)) {
    throw new CapabilityValidationError("maxPayloadSize must be a positive number", { details: { maxPayloadSize: request.maxPayloadSize } });
  }
  if (request.metadata !== undefined && (typeof request.metadata !== "object" || request.metadata === null || Array.isArray(request.metadata))) {
    throw new CapabilityValidationError("metadata must be a plain object", { details: { metadata: request.metadata } });
  }
  if (request.ttlMs !== undefined && (!Number.isFinite(request.ttlMs) || request.ttlMs <= 0)) {
    throw new CapabilityValidationError("ttlMs must be a positive number", { details: { ttlMs: request.ttlMs } });
  }
  return request;
}

/** Require a capability set to exist. @throws {CapabilityNotFoundError} */
export function requireCapability(record, ref) {
  if (!record) throw new CapabilityNotFoundError("Capability set not found", { details: { ref } });
  return record;
}

/**
 * Assert a set has not expired. Pure check — the caller decides whether to transition it to
 * EXPIRED. @throws {CapabilityExpiredError}
 * @param {object} record @param {number} [now]
 */
export function assertNotExpired(record, now = Date.now()) {
  if (record?.expiresAt && new Date(record.expiresAt).getTime() <= now && record.state !== "expired") {
    throw new CapabilityExpiredError("Capability set has expired", {
      details: { capabilityId: record.capabilityId, expiresAt: record.expiresAt },
    });
  }
  return record;
}

/**
 * Assert the acting user owns a capability set (only its owner may update/remove it).
 * @param {object} record @param {string} actingUserId @throws {UnauthorizedCapabilityError}
 */
export function assertOwner(record, actingUserId) {
  if (!actingUserId || String(record.userId) !== String(actingUserId)) {
    throw new UnauthorizedCapabilityError("Caller does not own this capability set", {
      details: { capabilityId: record.capabilityId },
    });
  }
  return record;
}

/**
 * Assert a registration does not duplicate an existing LIVE capability set for the same device.
 * A re-registration of an expired/removed set is allowed (it revives/replaces it).
 * @param {object|null} existing @param {boolean} existingLive whether the existing set is live
 * @throws {DuplicateCapabilityError}
 */
export function assertNoDuplicateRegistration(existing, existingLive) {
  if (existing && existingLive) {
    throw new DuplicateCapabilityError("Capabilities already registered for this device", {
      details: { capabilityId: existing.capabilityId, deviceId: existing.deviceId },
    });
  }
}

/**
 * Deep-scan an object graph for forbidden secret key material. The framework's core security
 * invariant. @param {any} value @param {string} [label] @throws {CorruptedCapabilityError}
 */
export function assertNoSecretMaterial(value, label = "capability set") {
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
        throw new CorruptedCapabilityError(`${label} must not contain secret material ("${key}")`, {
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
 * Validate a capability set's stored shape.
 * @param {object} record @throws {CorruptedCapabilityError}
 */
export function validateCapabilityRecord(record) {
  if (!record || typeof record !== "object") {
    throw new CorruptedCapabilityError("Capability set is not an object");
  }
  for (const field of ["capabilityId", "userId", "deviceId", "state", "protocolVersions", "transports"]) {
    if (record[field] === undefined || record[field] === null) {
      throw new CorruptedCapabilityError(`Capability set is missing "${field}"`, { details: { field } });
    }
  }
  if (!ALL_CAPABILITY_STATES.includes(record.state)) {
    throw new CorruptedCapabilityError(`Unknown capability state: ${record.state}`, { details: { state: record.state } });
  }
  assertNoSecretMaterial(record, "capability set");
  return record;
}

/**
 * Validate a repository implements the required capability-store contract.
 * @param {object} repo @param {string[]} [methods] @throws {CapabilityValidationError}
 */
export function validateCapabilityRepository(
  repo,
  methods = ["upsert", "create", "findById", "findByUserAndDevice", "findByUser", "update", "delete", "listByState", "listExpired", "countByState"],
) {
  if (!repo || typeof repo !== "object") {
    throw new CapabilityValidationError("Capability repository is missing or malformed");
  }
  for (const m of methods) {
    if (typeof repo[m] !== "function") {
      throw new CapabilityValidationError(`Capability repository is missing method "${m}"`, { details: { method: m } });
    }
  }
  return repo;
}

/**
 * Validate a repository implements the required negotiation-history store contract.
 * @param {object} repo @param {string[]} [methods] @throws {CapabilityValidationError}
 */
export function validateNegotiationRepository(repo, methods = ["record", "findById", "listByDevice", "listByPair"]) {
  if (!repo || typeof repo !== "object") {
    throw new CapabilityValidationError("Negotiation repository is missing or malformed");
  }
  for (const m of methods) {
    if (typeof repo[m] !== "function") {
      throw new CapabilityValidationError(`Negotiation repository is missing method "${m}"`, { details: { method: m } });
    }
  }
  return repo;
}

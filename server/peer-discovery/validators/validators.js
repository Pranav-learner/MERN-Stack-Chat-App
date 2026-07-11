/**
 * @module peer-discovery/validators
 *
 * Validation for the Peer Discovery Framework. Covers every spec item: unknown user,
 * unknown device, expired session, duplicate request, malformed request, unauthorized
 * lookup, corrupted metadata, and state transitions. State-transition validation itself
 * lives in {@link module:peer-discovery/lifecycle}; this module covers the rest and — most
 * importantly — enforces the framework's core invariant:
 *
 * @security A discovery record (session, metadata, or device descriptor) must NEVER carry
 * secret material: no private key, session key, message key, chain key, root key, MAC key,
 * or shared secret. {@link assertNoSecretMaterial} deep-scans for forbidden keys and is
 * invoked before anything is stored or returned.
 */

import {
  ALL_DISCOVERY_STATES,
  ALL_LOOKUP_TYPES,
  DiscoveryState,
} from "../types/types.js";
import {
  DiscoveryValidationError,
  DiscoveryNotFoundError,
  DiscoveryExpiredError,
  UnauthorizedDiscoveryError,
  CorruptedDiscoveryMetadataError,
  DuplicateDiscoveryError,
} from "../errors.js";

// User ids are Mongo ObjectId hex (24) but we also allow the broader id shape used across
// the crypto subsystems so device/session refs line up.
const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const DISCOVERY_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Field names that must NEVER appear anywhere in a discovery record. */
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

/** Validate a discovery id's shape. @throws {DiscoveryValidationError} */
export function validateDiscoveryId(discoveryId) {
  if (typeof discoveryId !== "string" || !DISCOVERY_ID_RE.test(discoveryId)) {
    throw new DiscoveryValidationError("Invalid discovery identifier", { details: { discoveryId } });
  }
  return discoveryId;
}

/** Validate a user-id reference. @throws {DiscoveryValidationError} */
export function validateUserRef(userId) {
  if (userId == null || typeof userId !== "string" || !USER_ID_RE.test(userId)) {
    throw new DiscoveryValidationError("Invalid user identifier", { details: { userId } });
  }
  return userId;
}

/** Validate a device-id reference. @throws {DiscoveryValidationError} */
export function validateDeviceRef(deviceId) {
  if (deviceId == null || typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
    throw new DiscoveryValidationError("Invalid device identifier", { details: { deviceId } });
  }
  return deviceId;
}

/** Validate a lookup type. @throws {DiscoveryValidationError} */
export function validateLookupType(lookupType) {
  if (!ALL_LOOKUP_TYPES.includes(lookupType)) {
    throw new DiscoveryValidationError(`Unknown lookup type "${lookupType}"`, { details: { lookupType } });
  }
  return lookupType;
}

/**
 * Validate a raw lookup request payload before it reaches the manager. Guards against
 * malformed discovery requests.
 * @param {object} request
 * @param {{ requireRequester?: boolean }} [options]
 * @returns {object} a normalized request
 * @throws {DiscoveryValidationError}
 */
export function validateLookupRequest(request, options = {}) {
  if (!request || typeof request !== "object") {
    throw new DiscoveryValidationError("Malformed discovery request");
  }
  if (options.requireRequester !== false) validateUserRef(request.requester);
  validateUserRef(request.targetUser);
  if (request.requesterDevice !== undefined && request.requesterDevice !== null) {
    validateDeviceRef(request.requesterDevice);
  }
  if (request.lookupType !== undefined) validateLookupType(request.lookupType);
  if (request.targetDevices !== undefined) {
    if (!Array.isArray(request.targetDevices)) {
      throw new DiscoveryValidationError("targetDevices must be an array", { details: { targetDevices: request.targetDevices } });
    }
    request.targetDevices.forEach(validateDeviceRef);
  }
  if (request.ttlMs !== undefined && (!Number.isFinite(request.ttlMs) || request.ttlMs <= 0)) {
    throw new DiscoveryValidationError("ttlMs must be a positive number", { details: { ttlMs: request.ttlMs } });
  }
  return request;
}

/** Require a discovery session to exist. @throws {DiscoveryNotFoundError} */
export function requireDiscoverySession(session, ref) {
  if (!session) throw new DiscoveryNotFoundError("Discovery session not found", { details: { ref } });
  return session;
}

/**
 * Assert a session has not expired. Pure check — the caller decides whether to transition
 * it to EXPIRED. @throws {DiscoveryExpiredError}
 * @param {import("../types/types.js").DiscoverySession} session @param {number} [now]
 */
export function assertNotExpired(session, now = Date.now()) {
  if (session?.expiresAt && new Date(session.expiresAt).getTime() <= now && session.state !== DiscoveryState.EXPIRED) {
    throw new DiscoveryExpiredError("Discovery session has expired", {
      details: { discoveryId: session.discoveryId, expiresAt: session.expiresAt },
    });
  }
  return session;
}

/**
 * Assert the acting user owns (is the requester of) a discovery session.
 * @param {import("../types/types.js").DiscoverySession} session @param {string} actingUserId
 * @throws {UnauthorizedDiscoveryError}
 */
export function assertRequester(session, actingUserId) {
  if (!actingUserId || String(session.requester) !== String(actingUserId)) {
    throw new UnauthorizedDiscoveryError("Caller is not the requester of this discovery session", {
      details: { discoveryId: session.discoveryId },
    });
  }
  return session;
}

/**
 * Assert a new lookup does not duplicate an already in-flight one.
 * @param {import("../types/types.js").DiscoverySession|null} existing an active session with the same dedupe key
 * @throws {DuplicateDiscoveryError}
 */
export function assertNoDuplicateDiscovery(existing) {
  if (existing) {
    throw new DuplicateDiscoveryError("A matching discovery request is already in progress", {
      details: { discoveryId: existing.discoveryId, targetUser: existing.targetUser },
    });
  }
}

/**
 * Deep-scan an object graph for forbidden secret key material. The framework's core
 * security invariant. @param {any} value @param {string} [label]
 * @throws {CorruptedDiscoveryMetadataError}
 */
export function assertNoSecretMaterial(value, label = "discovery record") {
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
        throw new CorruptedDiscoveryMetadataError(`${label} must not contain secret material ("${key}")`, {
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
 * Validate a resolved metadata record's shape (detects corruption/tampering + secret
 * leakage). @param {object} metadata @throws {CorruptedDiscoveryMetadataError}
 */
export function validateDiscoveryMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    throw new CorruptedDiscoveryMetadataError("Discovery metadata is not an object");
  }
  for (const field of ["userId", "deviceIds", "devices", "resolvedAt"]) {
    if (metadata[field] === undefined || metadata[field] === null) {
      throw new CorruptedDiscoveryMetadataError(`Discovery metadata is missing "${field}"`, { details: { field } });
    }
  }
  if (!Array.isArray(metadata.devices) || !Array.isArray(metadata.deviceIds)) {
    throw new CorruptedDiscoveryMetadataError("Discovery metadata device lists are malformed");
  }
  if (metadata.deviceIds.length !== metadata.devices.length) {
    throw new CorruptedDiscoveryMetadataError("Discovery metadata device id/descriptor counts disagree");
  }
  assertNoSecretMaterial(metadata, "discovery metadata");
  return metadata;
}

/**
 * Validate a discovery session record's stored shape.
 * @param {object} session @throws {CorruptedDiscoveryMetadataError}
 */
export function validateDiscoverySession(session) {
  if (!session || typeof session !== "object") {
    throw new CorruptedDiscoveryMetadataError("Discovery session is not an object");
  }
  for (const field of ["discoveryId", "requester", "targetUser", "state"]) {
    if (session[field] === undefined || session[field] === null) {
      throw new CorruptedDiscoveryMetadataError(`Discovery session is missing "${field}"`, { details: { field } });
    }
  }
  if (!ALL_DISCOVERY_STATES.includes(session.state)) {
    throw new CorruptedDiscoveryMetadataError(`Unknown discovery state: ${session.state}`, { details: { state: session.state } });
  }
  if (session.result) validateDiscoveryMetadata(session.result);
  assertNoSecretMaterial(session, "discovery session");
  return session;
}

/**
 * Validate a repository implements the required session-store contract.
 * @param {object} repo @param {string[]} [methods] @throws {DiscoveryValidationError}
 */
export function validateSessionRepository(
  repo,
  methods = ["create", "findById", "update", "delete", "findActiveByDedupeKey", "listByRequester", "listByState", "listExpired"],
) {
  if (!repo || typeof repo !== "object") {
    throw new DiscoveryValidationError("Discovery session repository is missing or malformed");
  }
  for (const m of methods) {
    if (typeof repo[m] !== "function") {
      throw new DiscoveryValidationError(`Discovery session repository is missing method "${m}"`, { details: { method: m } });
    }
  }
  return repo;
}

/**
 * Validate a repository implements the required registry-store contract.
 * @param {object} repo @param {string[]} [methods] @throws {DiscoveryValidationError}
 */
export function validateRegistryRepository(repo, methods = ["upsert", "findByUser", "findByUserAndDevice", "remove", "removeByUser", "listAll"]) {
  if (!repo || typeof repo !== "object") {
    throw new DiscoveryValidationError("Discovery registry repository is missing or malformed");
  }
  for (const m of methods) {
    if (typeof repo[m] !== "function") {
      throw new DiscoveryValidationError(`Discovery registry repository is missing method "${m}"`, { details: { method: m } });
    }
  }
  return repo;
}

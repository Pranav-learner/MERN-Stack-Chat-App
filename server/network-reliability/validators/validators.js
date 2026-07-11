/**
 * @module network-reliability/validators
 *
 * Validation for the Network Reliability subsystem — request/connection shape guards + the no-secret
 * invariant (defence in depth: connection records are metadata-only but are scanned before storage).
 *
 * @security {@link assertNoSecretMaterial} deep-scans for forbidden key names and is invoked before a
 * connection/recovery record is stored. Session CONTINUITY is a `sessionId` (an id, not a key).
 */

import { ALL_CONNECTION_STATES, ALL_RECOVERY_TRIGGERS } from "../types/types.js";
import {
  ReliabilityValidationError,
  ConnectionNotFoundError,
  UnauthorizedReliabilityError,
  CorruptedConnectionError,
} from "../errors.js";

const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Field names that must NEVER appear in a connection/recovery record. */
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

/** Validate a connection id's shape. @throws {ReliabilityValidationError} */
export function validateConnectionId(connectionId) {
  if (typeof connectionId !== "string" || !ID_RE.test(connectionId)) {
    throw new ReliabilityValidationError("Invalid connection identifier", { details: { connectionId } });
  }
  return connectionId;
}

/** Validate a user/device/peer id reference. @throws {ReliabilityValidationError} */
export function validateRef(id, label = "identifier") {
  if (id == null || typeof id !== "string" || !ID_RE.test(id)) {
    throw new ReliabilityValidationError(`Invalid ${label}`, { details: { id } });
  }
  return id;
}

/** Validate a user id. @throws {ReliabilityValidationError} */
export function validateUserRef(userId) {
  if (userId == null || typeof userId !== "string" || !USER_ID_RE.test(userId)) {
    throw new ReliabilityValidationError("Invalid user identifier", { details: { userId } });
  }
  return userId;
}

/** Validate a recovery trigger. @throws {ReliabilityValidationError} */
export function validateTrigger(trigger) {
  if (!ALL_RECOVERY_TRIGGERS.includes(trigger)) {
    throw new ReliabilityValidationError(`Unknown recovery trigger "${trigger}"`, { details: { trigger, allowed: [...ALL_RECOVERY_TRIGGERS] } });
  }
  return trigger;
}

/** Validate a retry-policy config. @throws {ReliabilityValidationError} */
export function validateRetryPolicy(policy) {
  if (policy === undefined) return policy;
  if (typeof policy !== "object" || policy === null) throw new ReliabilityValidationError("retryPolicy must be an object");
  if (policy.maxAttempts !== undefined && (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 0)) {
    throw new ReliabilityValidationError("retryPolicy.maxAttempts must be a non-negative integer");
  }
  if (policy.recoveryTimeoutMs !== undefined && (!Number.isFinite(policy.recoveryTimeoutMs) || policy.recoveryTimeoutMs <= 0)) {
    throw new ReliabilityValidationError("retryPolicy.recoveryTimeoutMs must be a positive number");
  }
  return policy;
}

/**
 * Validate a register-connection request. @param {object} request @throws {ReliabilityValidationError}
 */
export function validateRegisterRequest(request) {
  if (!request || typeof request !== "object") throw new ReliabilityValidationError("Malformed connection request");
  validateRef(request.deviceId, "device identifier");
  validateRef(request.peerId, "peer identifier");
  if (request.connectionId !== undefined) validateConnectionId(request.connectionId);
  if (request.state !== undefined && !ALL_CONNECTION_STATES.includes(request.state)) {
    throw new ReliabilityValidationError(`Unknown connection state "${request.state}"`, { details: { state: request.state } });
  }
  validateRetryPolicy(request.retryPolicy);
  if (request.metadata !== undefined && (typeof request.metadata !== "object" || request.metadata === null || Array.isArray(request.metadata))) {
    throw new ReliabilityValidationError("metadata must be a plain object", { details: { metadata: request.metadata } });
  }
  assertNoSecretMaterial(request, "connection request");
  return request;
}

/** Require a connection to exist. @throws {ConnectionNotFoundError} */
export function requireConnection(connection, ref) {
  if (!connection) throw new ConnectionNotFoundError("Active connection not found", { details: { ref } });
  return connection;
}

/** Assert a caller owns a connection (device-scoped). @throws {UnauthorizedReliabilityError} */
export function assertOwner(connection, actingUserId, actingDeviceId) {
  const deviceOk = actingDeviceId && String(connection.deviceId) === String(actingDeviceId);
  const userOk = actingUserId && (String(connection.userId ?? "") === String(actingUserId) || String(connection.deviceId) === String(actingUserId));
  if (!deviceOk && !userOk) {
    throw new UnauthorizedReliabilityError("Caller does not own this connection", { details: { connectionId: connection.connectionId } });
  }
  return connection;
}

/**
 * Deep-scan for forbidden secret key material. @param {any} value @param {string} [label]
 * @throws {CorruptedConnectionError}
 */
export function assertNoSecretMaterial(value, label = "connection record") {
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
        throw new CorruptedConnectionError(`${label} must not contain secret material ("${key}")`, { details: { key, path: `${path}.${key}` } });
      }
      walk(node[key], `${path}.${key}`);
    }
  };
  walk(value, label);
  return value;
}

/** Validate a stored connection record's shape. @throws {CorruptedConnectionError} */
export function validateConnection(connection) {
  if (!connection || typeof connection !== "object") throw new CorruptedConnectionError("Connection is not an object");
  for (const field of ["connectionId", "deviceId", "peerId", "state"]) {
    if (connection[field] === undefined || connection[field] === null) {
      throw new CorruptedConnectionError(`Connection is missing "${field}"`, { details: { field } });
    }
  }
  if (!ALL_CONNECTION_STATES.includes(connection.state)) {
    throw new CorruptedConnectionError(`Unknown connection state: ${connection.state}`, { details: { state: connection.state } });
  }
  assertNoSecretMaterial(connection, "connection");
  return connection;
}

/** Validate a repository implements the required connection-store contract. @throws {ReliabilityValidationError} */
export function validateRepository(repo, methods = ["create", "findById", "update", "delete", "listByDevice", "listLive", "listTimedOut"]) {
  if (!repo || typeof repo !== "object") throw new ReliabilityValidationError("Connection repository is missing or malformed");
  for (const m of methods) if (typeof repo[m] !== "function") throw new ReliabilityValidationError(`Connection repository is missing method "${m}"`, { details: { method: m } });
  return repo;
}

/**
 * @module media-reliability/validators
 *
 * Validation for the Media Reliability subsystem. Validates register requests, checkpoints, recovery
 * inputs, repository consistency, and enforces the no-content invariant.
 *
 * @security A reliability record carries CONTROL-PLANE metadata ONLY — NEVER media plaintext, ciphertext,
 * or key material. {@link assertNoContent} deep-scans before any persist.
 */

import { ALL_RECOVERY_TRIGGERS, ALL_OPERATION_TYPES } from "../types/types.js";
import { ReliabilityValidationError, OperationNotFoundError } from "../errors.js";

const ID_RE = /^[A-Za-z0-9_.:#@-]{1,200}$/;

/** Field names that must NEVER appear in a reliability record (secret / content markers). */
export const FORBIDDEN_KEYS = Object.freeze([
  "privateKey",
  "secretKey",
  "sharedSecret",
  "sessionKey",
  "mediaKey",
  "encryptionKey",
  "macKey",
  "messageKey",
  "chainKey",
  "rootKey",
  "keyBytes",
  "seed",
  "plaintext",
  "plainText",
  "cleartext",
  "decrypted",
  "ciphertext",
]);

/** Validate an id reference. @throws {ReliabilityValidationError} */
export function validateRef(id, label = "identifier") {
  if (id == null || typeof id !== "string" || !ID_RE.test(id)) throw new ReliabilityValidationError(`Invalid ${label}`, { details: { id } });
  return id;
}

/** Validate an operation type. @throws {ReliabilityValidationError} */
export function validateOperationType(type) {
  if (!ALL_OPERATION_TYPES.includes(type)) throw new ReliabilityValidationError(`Unknown media operation type "${type}"`, { details: { type } });
  return type;
}

/** Validate an operation-registration request. @throws {ReliabilityValidationError} */
export function validateRegisterRequest(request) {
  if (!request || typeof request !== "object") throw new ReliabilityValidationError("Malformed register request");
  validateRef(request.operationId ?? request.mediaId, "operation/media identifier");
  validateRef(request.mediaId, "media identifier");
  validateRef(request.deviceId, "device identifier");
  validateOperationType(request.operationType);
  if (request.userId != null) validateRef(request.userId, "user identifier");
  for (const field of ["totalChunks", "bytesTotal"]) {
    if (request[field] != null && (!Number.isInteger(request[field]) || request[field] < 0)) throw new ReliabilityValidationError(`${field} must be a non-negative integer`, { details: { [field]: request[field] } });
  }
  if (request.metadata) assertNoContent(request.metadata, "metadata");
  return request;
}

/** Validate a checkpoint update. @throws {ReliabilityValidationError} */
export function validateCheckpointUpdate(update) {
  if (!update || typeof update !== "object") throw new ReliabilityValidationError("Malformed checkpoint update");
  for (const field of ["totalChunks", "completedChunks", "cursor", "failedChunks", "pendingChunks", "retriedChunks", "bytesTotal", "bytesTransferred"]) {
    if (update[field] !== undefined && (!Number.isFinite(update[field]) || update[field] < 0)) throw new ReliabilityValidationError(`checkpoint.${field} is invalid`, { details: { [field]: update[field] } });
  }
  return update;
}

/** Validate a recovery trigger. @throws {ReliabilityValidationError} */
export function validateRecoveryTrigger(trigger) {
  if (!ALL_RECOVERY_TRIGGERS.includes(trigger)) throw new ReliabilityValidationError(`Unknown recovery trigger "${trigger}"`, { details: { trigger } });
  return trigger;
}

/** Require a record to exist. @throws {OperationNotFoundError} */
export function requireRecord(record, ref) {
  if (!record) throw new OperationNotFoundError("Media operation record not found", { details: { ref } });
  return record;
}

/**
 * Deep-scan for forbidden plaintext / secret / content material. @param {any} value @param {string} [label]
 * @throws {ReliabilityValidationError}
 */
export function assertNoContent(value, label = "record") {
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
      if (FORBIDDEN_KEYS.includes(key)) throw new ReliabilityValidationError(`${label} must not contain plaintext/secret/content material ("${key}")`, { details: { key, path: `${path}.${key}` } });
      walk(node[key], `${path}.${key}`);
    }
  };
  walk(value, label);
  return value;
}

/** Validate a repository implements the required store contract. */
export function validateRepository(repo) {
  if (!repo || typeof repo !== "object") throw new ReliabilityValidationError("Media reliability repository is missing or malformed");
  if (!repo.records || typeof repo.records !== "object") throw new ReliabilityValidationError("Reliability repository is missing the 'records' store");
  for (const m of ["create", "findById", "update", "listActive"]) if (typeof repo.records[m] !== "function") throw new ReliabilityValidationError(`records store is missing method "${m}"`, { details: { method: m } });
  return repo;
}

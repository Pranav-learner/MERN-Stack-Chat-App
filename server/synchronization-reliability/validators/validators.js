/**
 * @module synchronization-reliability/validators
 *
 * Validation for the Synchronization Reliability subsystem. Validates register requests, checkpoints,
 * recovery inputs, repository consistency, and enforces the no-plaintext invariant.
 *
 * @security A reliability record carries CONTROL-PLANE metadata ONLY — NEVER plaintext, message
 * content, or key material. {@link assertNoPlaintext} deep-scans before any persist.
 */

import { ALL_RECOVERY_TRIGGERS } from "../types/types.js";
import { ReliabilityValidationError, SyncRecordNotFoundError } from "../errors.js";

const ID_RE = /^[A-Za-z0-9_.:#@-]{1,200}$/;

/** Field names that must NEVER appear in a reliability record (secret / content markers). */
export const FORBIDDEN_KEYS = Object.freeze([
  "privateKey",
  "secretKey",
  "sharedSecret",
  "sessionKey",
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
  "payload",
  "body",
  "content",
  "text",
]);

/** Validate an id reference. @throws {ReliabilityValidationError} */
export function validateRef(id, label = "identifier") {
  if (id == null || typeof id !== "string" || !ID_RE.test(id)) throw new ReliabilityValidationError(`Invalid ${label}`, { details: { id } });
  return id;
}

/** Validate a sync-registration request. @throws {ReliabilityValidationError} */
export function validateRegisterRequest(request) {
  if (!request || typeof request !== "object") throw new ReliabilityValidationError("Malformed register request");
  validateRef(request.sessionId ?? request.syncId, "session/sync identifier");
  validateRef(request.deviceId, "device identifier");
  if (request.replicaId != null) validateRef(request.replicaId, "replica identifier");
  if (request.userId != null) validateRef(request.userId, "user identifier");
  if (request.totalOperations != null && (!Number.isInteger(request.totalOperations) || request.totalOperations < 0)) throw new ReliabilityValidationError("totalOperations must be a non-negative integer");
  if (request.metadata) assertNoPlaintext(request.metadata, "metadata");
  return request;
}

/** Validate a checkpoint update. @throws {ReliabilityValidationError} */
export function validateCheckpointUpdate(update) {
  if (!update || typeof update !== "object") throw new ReliabilityValidationError("Malformed checkpoint update");
  for (const field of ["totalOperations", "completedOperations", "cursor", "conflicts", "merges", "pendingOperations", "replicaDrift"]) {
    if (update[field] !== undefined && (!Number.isFinite(update[field]) || update[field] < 0)) throw new ReliabilityValidationError(`checkpoint.${field} is invalid`, { details: { [field]: update[field] } });
  }
  return update;
}

/** Validate a recovery trigger. @throws {ReliabilityValidationError} */
export function validateRecoveryTrigger(trigger) {
  if (!ALL_RECOVERY_TRIGGERS.includes(trigger)) throw new ReliabilityValidationError(`Unknown recovery trigger "${trigger}"`, { details: { trigger } });
  return trigger;
}

/** Require a record to exist. @throws {SyncRecordNotFoundError} */
export function requireRecord(record, ref) {
  if (!record) throw new SyncRecordNotFoundError("Sync reliability record not found", { details: { ref } });
  return record;
}

/**
 * Deep-scan for forbidden plaintext / secret / content material. @param {any} value @param {string} [label]
 * @throws {ReliabilityValidationError}
 */
export function assertNoPlaintext(value, label = "record") {
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
  if (!repo || typeof repo !== "object") throw new ReliabilityValidationError("Reliability repository is missing or malformed");
  if (!repo.records || typeof repo.records !== "object") throw new ReliabilityValidationError("Reliability repository is missing the 'records' store");
  for (const m of ["create", "findById", "update", "listActive"]) if (typeof repo.records[m] !== "function") throw new ReliabilityValidationError(`records store is missing method "${m}"`, { details: { method: m } });
  return repo;
}

/**
 * @module transport-reliability/validators
 *
 * Validation for the Data Plane Reliability subsystem. Validates register requests, checkpoints,
 * recovery/migration inputs, repository consistency, and enforces the no-plaintext invariant.
 *
 * @security A reliability record carries CONTROL-PLANE metadata ONLY — NEVER plaintext, ciphertext
 * bytes, or key material. {@link assertNoPlaintext} deep-scans before any persist.
 */

import { ALL_RECOVERY_TRIGGERS, ALL_MIGRATION_TRIGGERS } from "../types/types.js";
import { ReliabilityValidationError, TransferRecordNotFoundError } from "../errors.js";

const ID_RE = /^[A-Za-z0-9_.:#-]{1,160}$/;

/** Field names that must NEVER appear in a reliability record (secret/plaintext markers). */
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
  "payload",
  "data",
]);

/** Validate an id reference. @throws {ReliabilityValidationError} */
export function validateRef(id, label = "identifier") {
  if (id == null || typeof id !== "string" || !ID_RE.test(id)) {
    throw new ReliabilityValidationError(`Invalid ${label}`, { details: { id } });
  }
  return id;
}

/** Validate a transfer-registration request. @throws {ReliabilityValidationError} */
export function validateRegisterRequest(request) {
  if (!request || typeof request !== "object") throw new ReliabilityValidationError("Malformed register request");
  validateRef(request.transferId, "transfer identifier");
  validateRef(request.conversationId, "conversation identifier");
  validateRef(request.senderDeviceId, "sender device identifier");
  validateRef(request.receiverDeviceId, "receiver device identifier");
  if (!Number.isInteger(request.totalChunks) || request.totalChunks < 1) throw new ReliabilityValidationError("totalChunks must be >= 1", { details: { totalChunks: request.totalChunks } });
  if (request.connectionId != null) validateRef(request.connectionId, "connection identifier");
  assertNoPlaintext(request, "register request");
  return request;
}

/** Validate a checkpoint update. @throws {ReliabilityValidationError} */
export function validateCheckpointUpdate(update) {
  if (!update || typeof update !== "object") throw new ReliabilityValidationError("Malformed checkpoint update");
  for (const field of ["chunksAcked", "bytesTransferred", "highWaterMark", "outstanding", "retryCount", "totalChunks"]) {
    if (update[field] !== undefined && (!Number.isFinite(update[field]) || update[field] < (field === "highWaterMark" ? -1 : 0))) {
      throw new ReliabilityValidationError(`checkpoint.${field} is invalid`, { details: { [field]: update[field] } });
    }
  }
  if (update.missingIndices !== undefined && !Array.isArray(update.missingIndices)) throw new ReliabilityValidationError("checkpoint.missingIndices must be an array");
  return update;
}

/** Validate a recovery trigger. @throws {ReliabilityValidationError} */
export function validateRecoveryTrigger(trigger) {
  if (!ALL_RECOVERY_TRIGGERS.includes(trigger)) throw new ReliabilityValidationError(`Unknown recovery trigger "${trigger}"`, { details: { trigger } });
  return trigger;
}

/** Validate a migration trigger. @throws {ReliabilityValidationError} */
export function validateMigrationTrigger(trigger) {
  if (trigger !== undefined && !ALL_MIGRATION_TRIGGERS.includes(trigger)) throw new ReliabilityValidationError(`Unknown migration trigger "${trigger}"`, { details: { trigger } });
  return trigger;
}

/** Require a record to exist. @throws {TransferRecordNotFoundError} */
export function requireRecord(record, ref) {
  if (!record) throw new TransferRecordNotFoundError("Transfer reliability record not found", { details: { ref } });
  return record;
}

/**
 * Deep-scan for forbidden plaintext / secret / payload material. @param {any} value @param {string} [label]
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
      if (FORBIDDEN_KEYS.includes(key)) {
        throw new ReliabilityValidationError(`${label} must not contain plaintext/secret/payload material ("${key}")`, { details: { key, path: `${path}.${key}` } });
      }
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
  for (const m of ["create", "findById", "update", "listActive"]) {
    if (typeof repo.records[m] !== "function") throw new ReliabilityValidationError(`records store is missing method "${m}"`, { details: { method: m } });
  }
  return repo;
}

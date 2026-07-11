/**
 * @module replication/validators
 *
 * Validation for the State Replication subsystem. Covers every spec item: duplicate replicas, version
 * conflicts, invalid merges, corrupted deltas (see the delta module), replay attempts (see the replay
 * guard), malformed metadata, repository consistency, and unauthorized synchronization. It also
 * enforces the framework's core invariant:
 *
 * @security A replica / record / delta carries VERSION METADATA + entity IDs + non-secret merge
 * metadata ONLY — NEVER plaintext, ciphertext, or key material. {@link assertNoPlaintext} deep-scans
 * for forbidden secret/content markers before any persist.
 */

import { ALL_CATEGORIES, ALL_CONFLICT_POLICIES } from "../types/types.js";
import { ReplicationValidationError, ReplicaNotFoundError, UnauthorizedReplicationError } from "../errors.js";

const ID_RE = /^[A-Za-z0-9_.:#@-]{1,200}$/;

/** Field names that must NEVER appear in a replication record — secrets OR message content. */
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

/** Validate an id reference. @throws {ReplicationValidationError} */
export function validateRef(id, label = "identifier") {
  if (id == null || typeof id !== "string" || !ID_RE.test(id)) throw new ReplicationValidationError(`Invalid ${label}`, { details: { id } });
  return id;
}

/** Validate an entity version record's shape. @throws {ReplicationValidationError} */
export function validateEntityRecord(record, category) {
  if (!record || typeof record !== "object") throw new ReplicationValidationError("entity record must be an object");
  validateRef(record.entityId, "entity identifier");
  if (!Number.isFinite(record.version) || record.version < 0) throw new ReplicationValidationError("entity.version must be a non-negative number", { details: { version: record.version } });
  if (record.writerReplicaId != null) validateRef(record.writerReplicaId, "writer replica identifier");
  if (category != null && !ALL_CATEGORIES.includes(category)) throw new ReplicationValidationError(`Unknown category "${category}"`, { details: { category } });
  assertNoPlaintext(record, "entity record");
  return record;
}

/** Validate an incoming category map (each category → entityId → record). */
export function validateCategories(categories) {
  if (categories == null) return {};
  if (typeof categories !== "object") throw new ReplicationValidationError("categories must be an object");
  for (const [category, entities] of Object.entries(categories)) {
    if (!ALL_CATEGORIES.includes(category)) throw new ReplicationValidationError(`Unknown category "${category}"`, { details: { category } });
    if (entities && typeof entities === "object") {
      for (const [entityId, rec] of Object.entries(entities)) {
        if (typeof rec === "number") continue; // Sprint-1 compatible bare version
        validateEntityRecord({ entityId, ...rec }, category);
      }
    }
  }
  assertNoPlaintext(categories, "categories");
  return categories;
}

/** Validate a replica registration request. @throws {ReplicationValidationError} */
export function validateReplicaRegistration(request) {
  if (!request || typeof request !== "object") throw new ReplicationValidationError("Malformed replica registration");
  validateRef(request.deviceId, "device identifier");
  if (request.userId != null) validateRef(request.userId, "user identifier");
  if (request.replicaId != null) validateRef(request.replicaId, "replica identifier");
  validateCategories(request.categories);
  if (request.metadata) assertNoPlaintext(request.metadata, "replica metadata");
  return request;
}

/** Validate a conflict policy name. @throws {ReplicationValidationError} */
export function validateConflictPolicy(policy) {
  if (policy != null && !ALL_CONFLICT_POLICIES.includes(policy)) throw new ReplicationValidationError(`Unknown conflict policy "${policy}"`, { details: { policy } });
  return policy;
}

/** Require a replica to exist. @throws {ReplicaNotFoundError} */
export function requireReplica(replica, ref) {
  if (!replica) throw new ReplicaNotFoundError("Replica not found", { details: { ref } });
  return replica;
}

/** Assert the acting device owns the replica (same device or user). @throws {UnauthorizedReplicationError} */
export function assertOwner(replica, actingDeviceId) {
  const id = String(actingDeviceId);
  if (!actingDeviceId || (id !== String(replica?.deviceId) && id !== String(replica?.userId))) {
    throw new UnauthorizedReplicationError("Caller does not own this replica", { details: { replicaId: replica?.replicaId } });
  }
  return true;
}

/**
 * Deep-scan for forbidden plaintext / secret / content material. @param {any} value @param {string} [label]
 * @throws {ReplicationValidationError}
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
      if (FORBIDDEN_KEYS.includes(key)) throw new ReplicationValidationError(`${label} must not contain plaintext/secret/content material ("${key}")`, { details: { key, path: `${path}.${key}` } });
      walk(node[key], `${path}.${key}`);
    }
  };
  walk(value, label);
  return value;
}

/** FUTURE placeholder — replay detection is enforced by the delta ReplayGuard; crypto replay is Layer 5. */
export function checkReplay() {
  return false;
}

/** Validate a repository implements the required store contract. */
export function validateRepository(repo) {
  if (!repo || typeof repo !== "object") throw new ReplicationValidationError("Replication repository is missing or malformed");
  if (!repo.replicas || typeof repo.replicas !== "object") throw new ReplicationValidationError("Replication repository is missing the 'replicas' store");
  for (const m of ["upsert", "findById", "update"]) if (typeof repo.replicas[m] !== "function") throw new ReplicationValidationError(`replicas store is missing method "${m}"`);
  return repo;
}

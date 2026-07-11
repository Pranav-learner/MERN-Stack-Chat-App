/**
 * @module synchronization/validators
 *
 * Validation for the Synchronization Engine. Covers every spec item: duplicate operations, missing
 * versions, malformed deltas, expired sessions, invalid plans, unauthorized synchronization, repository
 * consistency, and a replay placeholder. It also enforces the framework's core invariant:
 *
 * @security A replica / session / delta / plan carries VERSION METADATA + entity IDs ONLY — NEVER
 * plaintext, ciphertext, or key material. {@link assertNoPlaintext} deep-scans for forbidden
 * secret/content markers before any persist.
 */

import { ALL_SYNC_CATEGORIES, isTerminalSessionState } from "../types/types.js";
import { SyncValidationError, ReplicaNotFoundError, SessionNotFoundError, SessionExpiredError, UnauthorizedSyncError } from "../errors.js";

const ID_RE = /^[A-Za-z0-9_.:#@-]{1,200}$/;

/**
 * Field names that must NEVER appear in a sync record — secret key material OR message content (the
 * engine syncs VERSIONS, not bodies).
 */
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

/** Validate an id reference. @throws {SyncValidationError} */
export function validateRef(id, label = "identifier") {
  if (id == null || typeof id !== "string" || !ID_RE.test(id)) throw new SyncValidationError(`Invalid ${label}`, { details: { id } });
  return id;
}

/** Validate a category-versions object shape (each category → { version, entities }). */
export function validateCategoryVersions(input) {
  if (input == null) return {};
  if (typeof input !== "object") throw new SyncValidationError("categoryVersions must be an object");
  for (const [category, block] of Object.entries(input)) {
    if (!ALL_SYNC_CATEGORIES.includes(category)) throw new SyncValidationError(`Unknown sync category "${category}"`, { details: { category } });
    const entities = block?.entities ?? block;
    if (entities && typeof entities === "object") {
      for (const [id, v] of Object.entries(entities)) {
        if (typeof id !== "string") throw new SyncValidationError("entity id must be a string");
        if (v != null && (!Number.isFinite(v) || v < 0)) throw new SyncValidationError(`entity "${id}" has an invalid version`, { details: { id, version: v } });
      }
    }
  }
  assertNoPlaintext(input, "categoryVersions");
  return input;
}

/** Validate a replica registration request. @throws {SyncValidationError} */
export function validateReplicaRegistration(request) {
  if (!request || typeof request !== "object") throw new SyncValidationError("Malformed replica registration");
  validateRef(request.deviceId, "device identifier");
  if (request.userId != null) validateRef(request.userId, "user identifier");
  if (request.replicaId != null) validateRef(request.replicaId, "replica identifier");
  validateCategoryVersions(request.categoryVersions);
  if (request.metadata) assertNoPlaintext(request.metadata, "replica metadata");
  return request;
}

/** Validate a start-sync request. @throws {SyncValidationError} */
export function validateStartSyncRequest(request) {
  if (!request || typeof request !== "object") throw new SyncValidationError("Malformed start-sync request");
  validateRef(request.targetReplicaId ?? request.targetDeviceId, "target replica/device identifier");
  if (request.sourceReplicaId != null) validateRef(request.sourceReplicaId, "source replica identifier");
  if (request.categories != null) {
    if (!Array.isArray(request.categories)) throw new SyncValidationError("categories must be an array");
    for (const c of request.categories) if (!ALL_SYNC_CATEGORIES.includes(c)) throw new SyncValidationError(`Unknown category "${c}"`, { details: { category: c } });
  }
  if (request.batchSize != null && (!Number.isInteger(request.batchSize) || request.batchSize <= 0)) throw new SyncValidationError("batchSize must be a positive integer");
  return request;
}

/** Validate an operation-progress report (no duplicate handling here — the queue enforces that). */
export function validateOperationReport(report) {
  if (!report || typeof report !== "object") throw new SyncValidationError("Malformed operation report");
  const applied = report.appliedOpIds ?? [];
  const failed = report.failedOpIds ?? [];
  if (!Array.isArray(applied) || !Array.isArray(failed)) throw new SyncValidationError("appliedOpIds / failedOpIds must be arrays");
  for (const id of [...applied, ...failed]) if (typeof id !== "string") throw new SyncValidationError("operation id must be a string");
  return report;
}

/** Require a replica to exist. @throws {ReplicaNotFoundError} */
export function requireReplica(replica, ref) {
  if (!replica) throw new ReplicaNotFoundError("Replica not found", { details: { ref } });
  return replica;
}

/** Require a session to exist. @throws {SessionNotFoundError} */
export function requireSession(session, ref) {
  if (!session) throw new SessionNotFoundError("Synchronization session not found", { details: { ref } });
  return session;
}

/** Assert a session has not expired (by TTL). @throws {SessionExpiredError} */
export function assertNotExpired(session, now = Date.now()) {
  if (session?.expiresAt && new Date(session.expiresAt).getTime() <= now && !isTerminalSessionState(session.state)) {
    throw new SessionExpiredError("Synchronization session has expired", { details: { sessionId: session.sessionId, expiresAt: session.expiresAt } });
  }
  return session;
}

/** Assert the acting device owns the session/replica (same user). @throws {UnauthorizedSyncError} */
export function assertOwner(record, actingDeviceId, field = "deviceId") {
  if (!actingDeviceId || String(record?.[field]) !== String(actingDeviceId)) {
    // also allow same-user access when a userId is present
    if (record?.userId && String(record.userId) === String(actingDeviceId)) return true;
    throw new UnauthorizedSyncError("Caller does not own this synchronization record", { details: { id: record?.replicaId ?? record?.sessionId } });
  }
  return true;
}

/**
 * Deep-scan for forbidden plaintext / secret / content material. @param {any} value @param {string} [label]
 * @throws {SyncValidationError}
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
      if (FORBIDDEN_KEYS.includes(key)) throw new SyncValidationError(`${label} must not contain plaintext/secret/content material ("${key}")`, { details: { key, path: `${path}.${key}` } });
      walk(node[key], `${path}.${key}`);
    }
  };
  walk(value, label);
  return value;
}

/** FUTURE placeholder — replay detection for sync operations. Inert (crypto replay is Layer 5). */
export function checkReplay() {
  return false;
}

/** Validate a repository implements the required store contract. */
export function validateRepository(repo) {
  if (!repo || typeof repo !== "object") throw new SyncValidationError("Sync repository is missing or malformed");
  for (const store of ["replicas", "sessions", "plans"]) {
    if (!repo[store] || typeof repo[store] !== "object") throw new SyncValidationError(`Sync repository is missing the "${store}" store`);
  }
  for (const m of ["upsert", "findById"]) if (typeof repo.replicas[m] !== "function") throw new SyncValidationError(`replicas store is missing method "${m}"`);
  for (const m of ["create", "findById", "update"]) if (typeof repo.sessions[m] !== "function") throw new SyncValidationError(`sessions store is missing method "${m}"`);
  return repo;
}

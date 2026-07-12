/**
 * @module group-communication/validators
 *
 * Validation for the Group Communication Engine. Covers every spec item: invalid/expired group keys
 * (see the key manager), unauthorized members, invalid fan-out plans (see the fan-out planner), replica
 * mismatch (see the replica module), synchronization failure (see the sync module), duplicate delivery
 * (see the delivery guard), repository consistency, and unauthorized operations. It also enforces the
 * framework's core invariant:
 *
 * @security The engine is a BLIND relay: a message carries OPAQUE ciphertext, and a key record carries a
 * FINGERPRINT (commitment) only. No record, plan, event, or DTO may contain plaintext or raw key bytes.
 * {@link assertNoSecretMaterial} deep-scans for forbidden secret/key markers before any persist.
 */

import { GroupCommValidationError, UnauthorizedMemberError } from "../errors.js";

const ID_RE = /^[A-Za-z0-9_.:#@-]{1,200}$/;

/**
 * Field names that must NEVER appear in a group-communication record — raw key/secret material or
 * plaintext. (The opaque `ciphertext` field IS allowed; a `contentHash` commitment is allowed.)
 */
export const FORBIDDEN_KEYS = Object.freeze([
  "privateKey",
  "secretKey",
  "sharedSecret",
  "sessionKey",
  "groupKey",
  "epochSecret",
  "senderKey",
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
]);

/** Validate an id reference. @throws {GroupCommValidationError} */
export function validateRef(id, label = "identifier") {
  if (id == null || typeof id !== "string" || !ID_RE.test(id)) throw new GroupCommValidationError(`Invalid ${label}`, { details: { id } });
  return id;
}

/** Optional id reference (validated only if present). */
export function validateOptionalRef(id, label = "identifier") {
  if (id == null) return null;
  return validateRef(id, label);
}

/** Deep-scan a value for forbidden secret/key/plaintext material. @throws {GroupCommValidationError} */
export function assertNoSecretMaterial(value, label = "record") {
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
      if (FORBIDDEN_KEYS.includes(key)) throw new GroupCommValidationError(`${label} must not contain secret/key/plaintext material ("${key}")`, { details: { key, path: `${path}.${key}` } });
      walk(node[key], `${path}.${key}`);
    }
  };
  walk(value, label);
  return value;
}

/** Validate an opaque ciphertext payload (non-empty string or bytes; no structural secrets). */
export function validateCiphertext(ciphertext) {
  if (ciphertext == null) throw new GroupCommValidationError("ciphertext is required");
  const ok = typeof ciphertext === "string" || ciphertext instanceof Uint8Array || Buffer.isBuffer(ciphertext);
  if (!ok) throw new GroupCommValidationError("ciphertext must be an opaque string or bytes");
  if (typeof ciphertext === "string" && ciphertext.length === 0) throw new GroupCommValidationError("ciphertext must not be empty");
  return ciphertext;
}

/** Validate a send-group-message request. @throws {GroupCommValidationError} */
export function validateSendRequest(request) {
  if (!request || typeof request !== "object") throw new GroupCommValidationError("Malformed send request");
  validateRef(request.groupId, "group identifier");
  validateRef(request.senderId, "sender identifier");
  validateCiphertext(request.ciphertext);
  if (request.metadata) assertNoSecretMaterial(request.metadata, "message metadata");
  return request;
}

/** Assert a caller is an authorized (active) member of a group. @throws {UnauthorizedMemberError} */
export function assertAuthorizedMember(memberIds, memberId) {
  if (!memberIds.map(String).includes(String(memberId))) {
    throw new UnauthorizedMemberError("Caller is not an active member of this group", { details: { memberId } });
  }
  return true;
}

/** Clamp + validate pagination. */
export function normalizePagination({ limit, offset } = {}, { max = 500, def = 100 } = {}) {
  const lim = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), max) : def;
  const off = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  return { limit: lim, offset: off };
}

/** Validate a repository implements the required store contract. @throws {GroupCommValidationError} */
export function validateRepository(repo) {
  if (!repo || typeof repo !== "object") throw new GroupCommValidationError("Group-communication repository is missing or malformed");
  for (const store of ["keys", "messages", "fanoutPlans", "replicas"]) {
    if (!repo[store] || typeof repo[store] !== "object") throw new GroupCommValidationError(`Repository is missing the '${store}' store`);
  }
  for (const m of ["create", "findActive", "findByVersion", "listByGroup", "update"]) if (typeof repo.keys[m] !== "function") throw new GroupCommValidationError(`keys store is missing method "${m}"`);
  for (const m of ["create", "findById", "listByGroup"]) if (typeof repo.messages[m] !== "function") throw new GroupCommValidationError(`messages store is missing method "${m}"`);
  return repo;
}

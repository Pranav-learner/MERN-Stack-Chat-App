/**
 * @module media-delivery/validators
 *
 * Validation for the Media Delivery subsystem. Covers corrupted preview/thumbnail (generator outcome),
 * streaming failure, synchronization failure, unauthorized streaming, repository consistency, malformed
 * metadata, and integrity preservation (per-chunk hash). Enforces the no-content invariant.
 *
 * @security A delivery record carries control-plane metadata + OPAQUE chunk hashes ONLY — NEVER
 * plaintext, ciphertext bytes (beyond a chunk in transit), or key material. {@link assertNoContent}
 * deep-scans metadata before any persist.
 */

import { ALL_PREVIEW_KINDS, ALL_PRIORITIES, TransferDirection } from "../types/types.js";
import { DeliveryValidationError, UnauthorizedDeliveryError, IntegrityError } from "../errors.js";

const ID_RE = /^[A-Za-z0-9_.:#@-]{1,200}$/;

/** Field names that must NEVER appear in a delivery metadata record. */
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
]);

/** Validate an id reference. @throws {DeliveryValidationError} */
export function validateRef(id, label = "identifier") {
  if (id == null || typeof id !== "string" || !ID_RE.test(id)) throw new DeliveryValidationError(`Invalid ${label}`, { details: { id } });
  return id;
}

/** Validate a non-negative integer index. */
export function validateIndex(index, label = "chunk index") {
  if (!Number.isInteger(index) || index < 0) throw new DeliveryValidationError(`Invalid ${label}`, { details: { index } });
  return index;
}

/** Deep-scan a metadata value for forbidden content/secret material. @throws {DeliveryValidationError} */
export function assertNoContent(value, label = "metadata") {
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
      if (FORBIDDEN_KEYS.includes(key)) throw new DeliveryValidationError(`${label} must not contain content/secret material ("${key}")`, { details: { key, path: `${path}.${key}` } });
      walk(node[key], `${path}.${key}`);
    }
  };
  walk(value, label);
  return value;
}

/** Validate a preview kind. */
export function validatePreviewKind(kind) {
  if (kind != null && !ALL_PREVIEW_KINDS.includes(kind)) throw new DeliveryValidationError(`Invalid preview kind "${kind}"`, { details: { kind } });
  return kind;
}

/** Validate a transfer priority. */
export function validatePriority(priority) {
  if (priority != null && !ALL_PRIORITIES.includes(priority)) throw new DeliveryValidationError(`Invalid priority "${priority}"`, { details: { priority } });
  return priority;
}

/** Validate a transfer direction. */
export function validateDirection(direction) {
  if (direction != null && ![TransferDirection.DOWNLOAD, TransferDirection.UPLOAD].includes(direction)) throw new DeliveryValidationError(`Invalid transfer direction "${direction}"`, { details: { direction } });
  return direction;
}

/** Assert a per-chunk hash matches (integrity preservation across the transport). @throws {IntegrityError} */
export function assertChunkIntegrity(actualHash, expectedHash, index) {
  if (expectedHash != null && actualHash !== expectedHash) {
    throw new IntegrityError(`Chunk ${index} failed integrity verification`, { details: { index } });
  }
  return true;
}

/** Assert the caller owns / may stream the media (owner or an allowed device). @throws {UnauthorizedDeliveryError} */
export function assertDeliveryAccess(session, actorId) {
  const id = String(actorId);
  if (!actorId || (id !== String(session.ownerId) && id !== String(session.deviceId))) {
    throw new UnauthorizedDeliveryError("Caller is not authorized for this delivery", { details: { sessionId: session.sessionId ?? session.transferId } });
  }
  return true;
}

/** Clamp + validate pagination. */
export function normalizePagination({ limit, offset } = {}, { max = 200, def = 50 } = {}) {
  const lim = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), max) : def;
  const off = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  return { limit: lim, offset: off };
}

/** Validate a repository implements the required store contract. @throws {DeliveryValidationError} */
export function validateRepository(repo) {
  if (!repo || typeof repo !== "object") throw new DeliveryValidationError("Media-delivery repository is missing or malformed");
  for (const store of ["sessions", "transfers", "previews", "availability"]) {
    if (!repo[store] || typeof repo[store] !== "object") throw new DeliveryValidationError(`Repository is missing the '${store}' store`);
  }
  for (const m of ["create", "findById", "update"]) if (typeof repo.sessions[m] !== "function") throw new DeliveryValidationError(`sessions store is missing method "${m}"`);
  for (const m of ["create", "findById", "update"]) if (typeof repo.transfers[m] !== "function") throw new DeliveryValidationError(`transfers store is missing method "${m}"`);
  return repo;
}

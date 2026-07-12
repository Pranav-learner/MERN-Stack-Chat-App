/**
 * @module group/validators
 *
 * Validation for the Group Foundation subsystem. Covers every spec item: duplicate members / invitations
 * (enforced in the manager against the repository), invalid ownership + circular ownership, invalid roles
 * (see {@link module:group/roles}), permission violations (see {@link module:group/permissions}), invalid
 * metadata (see {@link module:group/metadata}), version conflicts (see {@link module:group/versions}),
 * repository consistency, and unauthorized operations. It also enforces the framework's core invariant:
 *
 * @security A group is a control-plane entity: names / descriptions / tags are legitimate PUBLIC
 * metadata, but a group record must NEVER carry key material or message content. {@link assertNoSecrets}
 * deep-scans for forbidden key/secret markers before any persist. (Group *message* encryption arrives in
 * Sprint 2 and keeps its keys entirely out of this subsystem.)
 */

import { ALL_ROLES } from "../types/types.js";
import { GroupValidationError, GroupNotFoundError, MembershipNotFoundError, UnauthorizedGroupError, OwnershipError } from "../errors.js";

const ID_RE = /^[A-Za-z0-9_.:#@-]{1,200}$/;

/**
 * Field names that must NEVER appear in a group / membership / metadata record — cryptographic key or
 * secret material. (Group *content* like `name`/`description` IS allowed — the group control plane is
 * public; only its future messages are encrypted.)
 */
export const FORBIDDEN_KEYS = Object.freeze([
  "privateKey",
  "secretKey",
  "sharedSecret",
  "sessionKey",
  "encryptionKey",
  "groupKey",
  "senderKey",
  "macKey",
  "messageKey",
  "chainKey",
  "rootKey",
  "keyBytes",
  "seed",
  "ciphertext",
  "plaintext",
]);

/** Validate an id reference. @throws {GroupValidationError} */
export function validateRef(id, label = "identifier") {
  if (id == null || typeof id !== "string" || !ID_RE.test(id)) throw new GroupValidationError(`Invalid ${label}`, { details: { id } });
  return id;
}

/** Optional id reference (validated only if present). */
export function validateOptionalRef(id, label = "identifier") {
  if (id == null) return null;
  return validateRef(id, label);
}

/** Deep-scan a value for forbidden key/secret material. @throws {GroupValidationError} */
export function assertNoSecrets(value, label = "record") {
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
      if (FORBIDDEN_KEYS.includes(key)) throw new GroupValidationError(`${label} must not contain key/secret material ("${key}")`, { details: { key, path: `${path}.${key}` } });
      walk(node[key], `${path}.${key}`);
    }
  };
  walk(value, label);
  return value;
}

/**
 * Validate a create-group request. @param {object} request @throws {GroupValidationError}
 * @returns {object} the request
 */
export function validateGroupCreation(request) {
  if (!request || typeof request !== "object") throw new GroupValidationError("Malformed group creation request");
  validateRef(request.ownerId, "owner identifier");
  if (request.groupId != null) validateRef(request.groupId, "group identifier");
  if (request.metadata != null && typeof request.metadata !== "object") throw new GroupValidationError("metadata must be an object");
  if (request.metadata) assertNoSecrets(request.metadata, "group metadata");
  if (request.permissionOverrides) assertNoSecrets(request.permissionOverrides, "permission overrides");
  return request;
}

/** Require a group to exist. @throws {GroupNotFoundError} */
export function requireGroup(group, ref) {
  if (!group) throw new GroupNotFoundError("Group not found", { details: { ref } });
  return group;
}

/** Require a membership to exist. @throws {MembershipNotFoundError} */
export function requireMembership(membership, ref) {
  if (!membership) throw new MembershipNotFoundError("Membership not found", { details: { ref } });
  return membership;
}

/** Assert a target member is not the owner (owner cannot be removed / demoted without transfer). */
export function assertNotOwner(group, memberId, action = "operation") {
  if (String(group?.ownerId) === String(memberId)) {
    throw new OwnershipError(`Cannot ${action} the group owner — transfer ownership first`, { details: { groupId: group?.groupId, memberId } });
  }
  return true;
}

/**
 * Assert an ownership transfer is well-formed: the new owner differs from the current owner (no
 * circular / no-op transfer) and is a real id. @throws {OwnershipError}
 */
export function assertValidOwnershipTransfer(group, newOwnerId) {
  validateRef(newOwnerId, "new owner identifier");
  if (String(group?.ownerId) === String(newOwnerId)) {
    throw new OwnershipError("New owner is already the owner (circular / no-op transfer)", { code: "ERR_GROUP_OWNERSHIP", reason: "circular-ownership", details: { groupId: group?.groupId, newOwnerId } });
  }
  return true;
}

/** Assert the caller is the group owner. @throws {UnauthorizedGroupError} */
export function assertIsOwner(group, actorId) {
  if (!actorId || String(group?.ownerId) !== String(actorId)) {
    throw new UnauthorizedGroupError("Only the group owner may perform this operation", { details: { groupId: group?.groupId } });
  }
  return true;
}

/** Validate a role name (thin re-export for symmetry). @throws {GroupValidationError} */
export function validateRoleName(role, label = "role") {
  if (!ALL_ROLES.includes(role)) throw new GroupValidationError(`Invalid ${label} "${role}"`, { details: { role } });
  return role;
}

/** Clamp + validate pagination. */
export function normalizePagination({ limit, offset } = {}, { max = 500, def = 100 } = {}) {
  const lim = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), max) : def;
  const off = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  return { limit: lim, offset: off };
}

/** Validate a repository implements the required store contract. @throws {GroupValidationError} */
export function validateRepository(repo) {
  if (!repo || typeof repo !== "object") throw new GroupValidationError("Group repository is missing or malformed");
  for (const store of ["groups", "memberships"]) {
    if (!repo[store] || typeof repo[store] !== "object") throw new GroupValidationError(`Group repository is missing the '${store}' store`);
  }
  for (const m of ["create", "findById", "update"]) if (typeof repo.groups[m] !== "function") throw new GroupValidationError(`groups store is missing method "${m}"`);
  for (const m of ["upsert", "findByGroupAndMember", "listByGroup", "update"]) if (typeof repo.memberships[m] !== "function") throw new GroupValidationError(`memberships store is missing method "${m}"`);
  return repo;
}

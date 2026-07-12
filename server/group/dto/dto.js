/**
 * @module group/dto
 *
 * **Request DTOs + normalizers** for the Group Foundation subsystem. Where {@link module:group/serializers}
 * shapes what LEAVES the subsystem (responses), this module shapes what ENTERS it: it normalizes loose
 * HTTP/client input into the exact parameter objects the manager expects, so the controller stays thin
 * and every entry point coerces input the same way. Pure functions, no I/O.
 *
 * @security Normalizers pass metadata straight through to the validators layer, which enforces the
 * no-secret invariant — they never fabricate or strip security-relevant fields silently.
 */

/** Coerce to a trimmed string id or undefined. */
function id(v) {
  return v == null ? undefined : String(v);
}

/**
 * @typedef {object} CreateGroupDTO
 * @property {string} ownerId @property {object} metadata { name, description?, avatar?, tags?, visibility?, announcement? }
 * @property {object} [permissionOverrides] @property {Array<{ memberId: string, role?: string }>} [initialMembers]
 */

/** Normalize a create-group request into manager params. */
export function normalizeCreateGroup(input = {}) {
  const metadata = input.metadata ?? {
    name: input.name,
    description: input.description,
    avatar: input.avatar,
    tags: input.tags,
    visibility: input.visibility,
    announcement: input.announcement,
  };
  return {
    ownerId: id(input.ownerId),
    groupId: id(input.groupId),
    metadata,
    permissionOverrides: input.permissionOverrides,
    initialMembers: Array.isArray(input.initialMembers) ? input.initialMembers.map((m) => ({ memberId: id(m.memberId ?? m), role: m.role })) : [],
  };
}

/** Normalize an invite request. */
export function normalizeInvite(input = {}) {
  return { groupId: id(input.groupId), actorId: id(input.actorId), memberId: id(input.memberId), role: input.role };
}

/** Normalize a member-target request (accept/reject/join/leave/remove/ban). */
export function normalizeMemberTarget(input = {}) {
  return { groupId: id(input.groupId), actorId: id(input.actorId), memberId: id(input.memberId) };
}

/** Normalize an ownership-transfer request. */
export function normalizeTransferOwnership(input = {}) {
  return { groupId: id(input.groupId), actorId: id(input.actorId), newOwnerId: id(input.newOwnerId) };
}

/** Normalize a metadata-update request. */
export function normalizeMetadataUpdate(input = {}) {
  const patch = input.patch ?? input.metadata ?? {
    name: input.name,
    description: input.description,
    avatar: input.avatar,
    tags: input.tags,
    visibility: input.visibility,
    announcement: input.announcement,
    custom: input.custom,
  };
  // strip undefined keys so applyMetadataPatch only touches provided fields
  const clean = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) clean[k] = v;
  return { groupId: id(input.groupId), actorId: id(input.actorId), patch: clean, expectedVersion: input.expectedVersion };
}

/** Normalize a role-change request. */
export function normalizeRoleChange(input = {}) {
  return { groupId: id(input.groupId), actorId: id(input.actorId), memberId: id(input.memberId), role: input.role };
}

/** Normalize a permission-override request. */
export function normalizePermissionChange(input = {}) {
  return { groupId: id(input.groupId), actorId: id(input.actorId), overrides: input.overrides ?? input.permissionOverrides };
}

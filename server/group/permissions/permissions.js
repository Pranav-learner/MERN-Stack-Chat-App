/**
 * @module group/permissions
 *
 * **Permission system** for the Group Foundation subsystem. Effective permissions are computed as:
 *
 *   `effective(role) = DEFAULT_ROLE_PERMISSIONS[role]  −  overrides[role].revoke  +  overrides[role].grant`
 *
 * A group carries an optional per-role OVERRIDE layer (`{ [role]: { grant: [...], revoke: [...] } }`) so
 * a deployment can tune what each role may do WITHOUT code changes — e.g. let ordinary members invite,
 * or forbid admins from editing metadata. `owner` always keeps every permission (an override cannot
 * lock the owner out); `manage-permissions`, `delete-group`, and `transfer-ownership` can never be
 * granted to a non-owner via overrides (they are structurally owner-only).
 *
 * Pure functions, no I/O. This is the seam future group-messaging permissions (post / pin / react)
 * extend by adding permission keys + defaults.
 *
 * @security Reasons over permission names + role names ONLY — never content or keys.
 */

import { GroupRole, GroupPermission, ALL_PERMISSIONS, ALL_ROLES, DEFAULT_ROLE_PERMISSIONS } from "../types/types.js";
import { GroupValidationError } from "../errors.js";

/** Permissions that are structurally owner-only and can NEVER be granted to another role. */
export const OWNER_ONLY_PERMISSIONS = Object.freeze([
  GroupPermission.MANAGE_PERMISSIONS,
  GroupPermission.DELETE_GROUP,
  GroupPermission.TRANSFER_OWNERSHIP,
]);

/** Validate a permission name. @throws {GroupValidationError} */
export function validatePermission(permission, label = "permission") {
  if (!ALL_PERMISSIONS.includes(permission)) throw new GroupValidationError(`Invalid ${label} "${permission}"`, { details: { permission } });
  return permission;
}

/**
 * Validate a permission-override map. Shape: `{ [role]: { grant?: string[], revoke?: string[] } }`.
 * Rejects unknown roles/permissions and any attempt to grant an owner-only permission to a non-owner.
 * @throws {GroupValidationError} @returns {object} the (unchanged) overrides
 */
export function validatePermissionOverrides(overrides) {
  if (overrides == null) return {};
  if (typeof overrides !== "object" || Array.isArray(overrides)) throw new GroupValidationError("permission overrides must be an object");
  for (const [role, spec] of Object.entries(overrides)) {
    if (!ALL_ROLES.includes(role)) throw new GroupValidationError(`Unknown role in overrides "${role}"`, { details: { role } });
    if (spec == null || typeof spec !== "object") throw new GroupValidationError(`Override for role "${role}" must be an object`);
    for (const bucket of ["grant", "revoke"]) {
      const list = spec[bucket];
      if (list == null) continue;
      if (!Array.isArray(list)) throw new GroupValidationError(`overrides.${role}.${bucket} must be an array`);
      for (const p of list) validatePermission(p, `overrides.${role}.${bucket}`);
    }
    if (role !== GroupRole.OWNER && spec.grant) {
      const illegal = spec.grant.find((p) => OWNER_ONLY_PERMISSIONS.includes(p));
      if (illegal) throw new GroupValidationError(`Permission "${illegal}" is owner-only and cannot be granted to "${role}"`, { details: { role, permission: illegal } });
    }
  }
  return overrides;
}

/** The default (pre-override) permission set for a role. Returns a fresh array. */
export function defaultPermissionsForRole(role) {
  return [...(DEFAULT_ROLE_PERMISSIONS[role] ?? [])];
}

/**
 * The EFFECTIVE permission set for a role given a group's overrides. Deterministic + order-stable
 * (follows {@link ALL_PERMISSIONS}). Owner always gets everything.
 * @returns {string[]}
 */
export function resolvePermissions(role, overrides = {}) {
  if (role === GroupRole.OWNER) return [...ALL_PERMISSIONS];
  const set = new Set(defaultPermissionsForRole(role));
  const spec = overrides?.[role];
  if (spec) {
    for (const p of spec.revoke ?? []) set.delete(p);
    for (const p of spec.grant ?? []) if (!OWNER_ONLY_PERMISSIONS.includes(p)) set.add(p);
  }
  return ALL_PERMISSIONS.filter((p) => set.has(p));
}

/** Whether a role has a permission under the given overrides. */
export function hasPermission(role, permission, overrides = {}) {
  return resolvePermissions(role, overrides).includes(permission);
}

/**
 * The full effective permission matrix (role → permission[]) for a group's overrides — the shape the
 * API returns for "get permissions".
 */
export function permissionMatrix(overrides = {}) {
  return Object.fromEntries(ALL_ROLES.map((role) => [role, resolvePermissions(role, overrides)]));
}

export { GroupPermission, ALL_PERMISSIONS };

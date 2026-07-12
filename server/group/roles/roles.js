/**
 * @module group/roles
 *
 * **Role management** for the Group Foundation subsystem. Roles are RANKED (`owner` > `administrator` >
 * `moderator` > `member` > `guest`). The core rule the whole subsystem leans on: an actor may only
 * manage (assign a role to / remove / mute) a member whose role ranks STRICTLY LOWER than the actor's,
 * and may only assign a role STRICTLY BELOW their own. This prevents privilege escalation without any
 * per-operation special-casing.
 *
 * `moderator` + `guest` are future-ready — defined, ranked, and permissioned so Sprint 2 needs no
 * schema change. Pure functions, no I/O.
 *
 * @security Role logic reasons over role names + ranks ONLY — never content or keys.
 */

import { GroupRole, ALL_ROLES, ROLE_RANK } from "../types/types.js";
import { InvalidRoleError } from "../errors.js";

/** Validate a role name. @throws {InvalidRoleError} @returns {string} the role */
export function validateRole(role, label = "role") {
  if (!ALL_ROLES.includes(role)) throw new InvalidRoleError(`Invalid ${label} "${role}"`, { details: { role } });
  return role;
}

/** The numeric rank of a role (higher outranks lower). Unknown → -1. */
export function roleRank(role) {
  return ROLE_RANK[role] ?? -1;
}

/** Whether `role` ranks at least as high as `other`. */
export function isRoleAtLeast(role, other) {
  return roleRank(role) >= roleRank(other);
}

/** Whether `actorRole` strictly outranks `targetRole` (the precondition for managing them). */
export function outranks(actorRole, targetRole) {
  return roleRank(actorRole) > roleRank(targetRole);
}

/**
 * Whether an actor can assign `desiredRole` to a target currently holding `targetRole`. Owner can
 * assign anything below owner; everyone else must strictly outrank BOTH the target's current role and
 * the desired role. Nobody may assign `owner` via a role change (ownership moves only through
 * {@link module:group/manager transfer ownership}).
 */
export function canAssignRole(actorRole, targetCurrentRole, desiredRole) {
  if (desiredRole === GroupRole.OWNER) return false; // ownership is transferred, not assigned
  if (actorRole === GroupRole.OWNER) return true;
  return outranks(actorRole, targetCurrentRole) && outranks(actorRole, desiredRole);
}

/** Whether an actor can manage (remove / mute / change state of) a member with `targetRole`. */
export function canManageMember(actorRole, targetRole) {
  if (actorRole === GroupRole.OWNER) return true;
  return outranks(actorRole, targetRole);
}

/** The roles an actor is allowed to assign to others (strictly below their own; never owner). */
export function assignableRoles(actorRole) {
  const rank = roleRank(actorRole);
  return ALL_ROLES.filter((r) => r !== GroupRole.OWNER && (actorRole === GroupRole.OWNER || roleRank(r) < rank));
}

/** A view of the role hierarchy (name + rank), highest first — handy for clients + docs. */
export function roleHierarchy() {
  return [...ALL_ROLES].sort((a, b) => roleRank(b) - roleRank(a)).map((role) => ({ role, rank: roleRank(role) }));
}

export { GroupRole, ALL_ROLES };

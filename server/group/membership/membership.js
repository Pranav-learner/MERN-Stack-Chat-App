/**
 * @module group/membership
 *
 * The **Membership** model — pure helpers for the record that binds one member to one group with a
 * role, a lifecycle state, and its own version. The heavier orchestration (who may invite/remove/
 * transfer, and the repository writes) lives in {@link module:group/manager}; this module owns the
 * SHAPE of a membership and the pure state/role transitions on it, so both the manager and tests build
 * memberships the same way.
 *
 * @security A membership carries ids + role + state + timestamps + non-secret metadata ONLY — never
 * content or keys.
 *
 * Pure functions — every mutation returns a NEW membership (immutable), which keeps the manager's
 * reconciliation deterministic + side-effect free.
 */

import crypto from "node:crypto";
import { GroupRole, MembershipState, GROUP_SCHEMA_VERSION } from "../types/types.js";
import { assertTransition } from "../lifecycle/lifecycle.js";
import { validateRole } from "../roles/roles.js";

/**
 * Build a membership record. @param {object} params
 * @param {string} params.groupId @param {string} params.memberId @param {string} [params.role]
 * @param {string} [params.state] @param {string|null} [params.invitedBy] @param {object} [params.metadata]
 * @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 * @returns {import("../types/types.js").Membership}
 */
export function createMembership(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowIso = new Date(clock()).toISOString();
  const state = params.state ?? MembershipState.ACTIVE;
  const joined = state === MembershipState.ACTIVE ? nowIso : null;
  return {
    membershipId: params.membershipId ?? idGenerator(),
    groupId: String(params.groupId),
    memberId: String(params.memberId),
    role: validateRole(params.role ?? GroupRole.MEMBER),
    state,
    invitedBy: params.invitedBy != null ? String(params.invitedBy) : null,
    invitedAt: params.invitedAt ?? nowIso,
    joinedAt: params.joinedAt ?? joined,
    metadata: params.metadata ?? {},
    version: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Transition a membership to a new state (validated). Returns a NEW membership with a bumped `version`
 * and `joinedAt` stamped the first time it becomes ACTIVE. @throws {InvalidStateTransitionError}
 */
export function transitionMembership(membership, toState, at = new Date().toISOString()) {
  assertTransition(membership.state, toState);
  if (membership.state === toState) return membership; // no-op
  const next = { ...membership, state: toState, version: (membership.version ?? 1) + 1, updatedAt: at };
  if (toState === MembershipState.ACTIVE && !membership.joinedAt) next.joinedAt = at;
  return next;
}

/** Change a membership's role (validated). Returns a NEW membership with a bumped `version`. */
export function assignMembershipRole(membership, role, at = new Date().toISOString()) {
  validateRole(role);
  if (membership.role === role) return membership; // no-op
  return { ...membership, role, version: (membership.version ?? 1) + 1, updatedAt: at };
}

/** A compact history entry describing a membership change. */
export function membershipHistoryEntry({ membership, action, fromState, toState, fromRole, toRole, actorId, at }) {
  return {
    membershipId: membership?.membershipId,
    memberId: membership?.memberId,
    action,
    fromState: fromState ?? null,
    toState: toState ?? membership?.state ?? null,
    fromRole: fromRole ?? null,
    toRole: toRole ?? membership?.role ?? null,
    actorId: actorId ?? null,
    at: at ?? membership?.updatedAt ?? new Date().toISOString(),
  };
}

export { GroupRole, MembershipState, GROUP_SCHEMA_VERSION };

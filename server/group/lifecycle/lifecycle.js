/**
 * @module group/lifecycle
 *
 * **Membership lifecycle state machine.** Every membership moves through a validated set of states
 * (`invited → active`, `active → muted`, `active → left/removed/banned`, …). This module is the single
 * authority for "is this transition legal?" — the manager never mutates a membership's state without
 * asking here first, so illegal jumps (e.g. `banned → active`, or any transition out of the terminal
 * `deleted`) are impossible by construction.
 *
 * The group ENTITY has its own small lifecycle too (`active ↔ archived → deleted`), validated the same
 * way. Pure functions, no I/O.
 *
 * @security Reasons over state names ONLY — never content or keys.
 */

import {
  MembershipState,
  MEMBERSHIP_TRANSITIONS,
  ACTIVE_MEMBERSHIP_STATES,
  PENDING_MEMBERSHIP_STATES,
  TERMINAL_MEMBERSHIP_STATES,
  GroupState,
  GROUP_STATE_TRANSITIONS,
  ALL_MEMBERSHIP_STATES,
  ALL_GROUP_STATES,
} from "../types/types.js";
import { InvalidStateTransitionError, GroupValidationError, GroupStateError } from "../errors.js";

// === membership lifecycle ===================================================

/** Validate a membership state name. @throws {GroupValidationError} */
export function validateMembershipState(state, label = "membership state") {
  if (!ALL_MEMBERSHIP_STATES.includes(state)) throw new GroupValidationError(`Invalid ${label} "${state}"`, { details: { state } });
  return state;
}

/** The states reachable from `from` in one step. */
export function nextStatesOf(from) {
  return [...(MEMBERSHIP_TRANSITIONS[from] ?? [])];
}

/** Whether `from → to` is a legal membership transition (a self-transition is a no-op, allowed). */
export function canTransition(from, to) {
  if (from === to) return true;
  return (MEMBERSHIP_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert `from → to` is legal. @throws {InvalidStateTransitionError} */
export function assertTransition(from, to) {
  validateMembershipState(from, "current state");
  validateMembershipState(to, "target state");
  if (!canTransition(from, to)) {
    throw new InvalidStateTransitionError(`Cannot transition membership from "${from}" to "${to}"`, { details: { from, to, allowed: nextStatesOf(from) } });
  }
  return true;
}

/** Whether a state is terminal (no outgoing transitions). */
export function isTerminalState(state) {
  return TERMINAL_MEMBERSHIP_STATES.includes(state);
}

/** Whether a state counts the member as "in" the group. */
export function isActiveState(state) {
  return ACTIVE_MEMBERSHIP_STATES.includes(state);
}

/** Whether a state is awaiting a decision (invited/pending). */
export function isPendingState(state) {
  return PENDING_MEMBERSHIP_STATES.includes(state);
}

// === group-entity lifecycle =================================================

/** Validate a group state name. @throws {GroupValidationError} */
export function validateGroupState(state, label = "group state") {
  if (!ALL_GROUP_STATES.includes(state)) throw new GroupValidationError(`Invalid ${label} "${state}"`, { details: { state } });
  return state;
}

/** Whether a group-entity transition `from → to` is legal. */
export function canTransitionGroup(from, to) {
  if (from === to) return true;
  return (GROUP_STATE_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a group-entity transition is legal. @throws {InvalidStateTransitionError} */
export function assertGroupTransition(from, to) {
  validateGroupState(from, "current group state");
  validateGroupState(to, "target group state");
  if (!canTransitionGroup(from, to)) {
    throw new InvalidStateTransitionError(`Cannot transition group from "${from}" to "${to}"`, { details: { from, to } });
  }
  return true;
}

/** Assert the group is ACTIVE (mutations require it). @throws {GroupStateError} */
export function assertGroupActive(group) {
  if (group?.state !== GroupState.ACTIVE) {
    throw new GroupStateError(`Group is "${group?.state}" — membership mutations require an active group`, { details: { groupId: group?.groupId, state: group?.state } });
  }
  return true;
}

export { MembershipState, GroupState };

/**
 * @module capabilities/lifecycle
 *
 * The deterministic finite state machine governing a capability set's lifecycle. Defines the legal
 * transitions between {@link CapabilityState}s and validates every transition the
 * {@link module:capabilities/manager} performs. Pure logic — no I/O, no crypto, no transport.
 *
 * Like presence, a capability set is **cyclic**: `EXPIRED` is a resting state a refresh /
 * re-registration revives. `REMOVED` is terminal (a new registration starts a fresh record).
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> registered
 *   registered --> advertised: advertise
 *   registered --> registered: update
 *   advertised --> advertised: update / refresh
 *   registered --> expired: ttl
 *   advertised --> expired: ttl
 *   expired --> advertised: refresh / re-register
 *   expired --> registered: re-register
 *   registered --> removed
 *   advertised --> removed
 *   expired --> removed
 *   removed --> [*]
 * ```
 */

import { CapabilityState, ALL_CAPABILITY_STATES } from "../types/types.js";
import { InvalidCapabilityTransitionError } from "../errors.js";

/**
 * Legal transitions keyed by source state. `REMOVED` is terminal.
 * @type {Readonly<Record<string, string[]>>}
 */
export const ALLOWED_CAPABILITY_TRANSITIONS = Object.freeze({
  [CapabilityState.REGISTERED]: [CapabilityState.ADVERTISED, CapabilityState.EXPIRED, CapabilityState.REMOVED],
  [CapabilityState.ADVERTISED]: [CapabilityState.EXPIRED, CapabilityState.REMOVED],
  [CapabilityState.EXPIRED]: [CapabilityState.REGISTERED, CapabilityState.ADVERTISED, CapabilityState.REMOVED],
  [CapabilityState.REMOVED]: [],
});

/** Whether `from -> to` is a legal transition (a self-transition is always allowed for updates). */
export function canCapabilityTransition(from, to) {
  if (from === to) return true; // idempotent update/refresh in place
  return (ALLOWED_CAPABILITY_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a transition is legal. @throws {InvalidCapabilityTransitionError} */
export function assertCapabilityTransition(from, to) {
  if (!ALL_CAPABILITY_STATES.includes(to)) {
    throw new InvalidCapabilityTransitionError(`Unknown capability state "${to}"`, { details: { from, to } });
  }
  if (!canCapabilityTransition(from, to)) {
    throw new InvalidCapabilityTransitionError(`Cannot transition capability from "${from}" to "${to}"`, {
      details: { from, to, allowed: ALLOWED_CAPABILITY_TRANSITIONS[from] ?? [] },
    });
  }
}

/** States reachable in one legal step from `state`. @returns {string[]} */
export function nextCapabilityStates(state) {
  return [...(ALLOWED_CAPABILITY_TRANSITIONS[state] ?? [])];
}

/** Whether a state is terminal. @param {string} state @returns {boolean} */
export function isTerminalCapabilityState(state) {
  return state === CapabilityState.REMOVED;
}

/**
 * A small stateful wrapper for driving one capability set's lifecycle + recording history. Holds
 * no I/O; the manager persists the state.
 *
 * @example
 * ```js
 * const fsm = new CapabilityLifecycle(CapabilityState.REGISTERED);
 * fsm.transition(CapabilityState.ADVERTISED);
 * fsm.transition(CapabilityState.EXPIRED, { reason: "ttl" });
 * fsm.state; // "expired"
 * ```
 */
export class CapabilityLifecycle {
  /** @param {string} [initial=CapabilityState.REGISTERED] @param {{ clock?: () => number, history?: object[] }} [options] */
  constructor(initial = CapabilityState.REGISTERED, options = {}) {
    if (!ALL_CAPABILITY_STATES.includes(initial)) {
      throw new InvalidCapabilityTransitionError(`Unknown initial capability state "${initial}"`, { details: { initial } });
    }
    this._state = initial;
    this._clock = options.clock ?? (() => Date.now());
    this._history = options.history ? [...options.history] : [];
  }

  /** @returns {string} */
  get state() {
    return this._state;
  }
  /** @returns {object[]} */
  get history() {
    return [...this._history];
  }
  /** @returns {boolean} */
  get isTerminal() {
    return isTerminalCapabilityState(this._state);
  }
  /** @returns {string[]} */
  get next() {
    return nextCapabilityStates(this._state);
  }

  /** Whether a transition to `to` is currently legal. @returns {boolean} */
  can(to) {
    return canCapabilityTransition(this._state, to);
  }

  /**
   * Perform a transition, recording it in history.
   * @param {string} to @param {{ reason?: string }} [meta]
   * @returns {string} the new state @throws {InvalidCapabilityTransitionError}
   */
  transition(to, meta = {}) {
    assertCapabilityTransition(this._state, to);
    const entry = { from: this._state, to, at: new Date(this._clock()).toISOString() };
    if (meta.reason !== undefined) entry.reason = meta.reason;
    this._history.push(entry);
    this._state = to;
    return this._state;
  }
}

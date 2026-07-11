/**
 * @module peer-discovery/lifecycle
 *
 * The deterministic finite state machine governing a discovery session's lifecycle.
 * Defines the legal transitions between {@link DiscoveryState}s and validates every
 * transition the {@link module:peer-discovery/manager} performs. Pure logic — no I/O,
 * no crypto, no transport.
 *
 * A successful lookup walks `CREATED → PENDING → SEARCHING → RESOLVED → COMPLETED`.
 * Any live state can fail, expire, or be cancelled. Terminal states have no exits.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> created
 *   created --> pending
 *   created --> searching
 *   created --> cancelled
 *   created --> failed
 *   created --> expired
 *   pending --> searching
 *   pending --> cancelled
 *   pending --> failed
 *   pending --> expired
 *   searching --> resolved
 *   searching --> failed
 *   searching --> cancelled
 *   searching --> expired
 *   resolved --> completed
 *   resolved --> cancelled
 *   resolved --> expired
 *   completed --> [*]
 *   failed --> [*]
 *   expired --> [*]
 *   cancelled --> [*]
 * ```
 */

import { DiscoveryState, isTerminalDiscoveryState } from "../types/types.js";
import { InvalidDiscoveryTransitionError } from "../errors.js";

/**
 * Legal transitions keyed by source state. FAILED / EXPIRED / CANCELLED / COMPLETED are
 * terminal.
 * @type {Readonly<Record<string, string[]>>}
 */
export const ALLOWED_DISCOVERY_TRANSITIONS = Object.freeze({
  [DiscoveryState.CREATED]: [
    DiscoveryState.PENDING,
    DiscoveryState.SEARCHING,
    DiscoveryState.CANCELLED,
    DiscoveryState.FAILED,
    DiscoveryState.EXPIRED,
  ],
  [DiscoveryState.PENDING]: [
    DiscoveryState.SEARCHING,
    DiscoveryState.CANCELLED,
    DiscoveryState.FAILED,
    DiscoveryState.EXPIRED,
  ],
  [DiscoveryState.SEARCHING]: [
    DiscoveryState.RESOLVED,
    DiscoveryState.FAILED,
    DiscoveryState.CANCELLED,
    DiscoveryState.EXPIRED,
  ],
  [DiscoveryState.RESOLVED]: [
    DiscoveryState.COMPLETED,
    DiscoveryState.CANCELLED,
    DiscoveryState.EXPIRED,
  ],
  [DiscoveryState.COMPLETED]: [],
  [DiscoveryState.FAILED]: [],
  [DiscoveryState.EXPIRED]: [],
  [DiscoveryState.CANCELLED]: [],
});

/** Whether `from -> to` is a legal transition. @returns {boolean} */
export function canDiscoveryTransition(from, to) {
  return (ALLOWED_DISCOVERY_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a transition is legal. @throws {InvalidDiscoveryTransitionError} */
export function assertDiscoveryTransition(from, to) {
  if (!canDiscoveryTransition(from, to)) {
    throw new InvalidDiscoveryTransitionError(`Cannot transition discovery from "${from}" to "${to}"`, {
      details: { from, to, allowed: ALLOWED_DISCOVERY_TRANSITIONS[from] ?? [] },
    });
  }
}

/** States reachable in one legal step from `state`. @returns {string[]} */
export function nextDiscoveryStates(state) {
  return [...(ALLOWED_DISCOVERY_TRANSITIONS[state] ?? [])];
}

/**
 * A small stateful wrapper for driving a single discovery session's lifecycle and
 * recording its transition history. Holds no I/O; the manager persists the state.
 *
 * @example
 * ```js
 * const fsm = new DiscoveryLifecycle(DiscoveryState.CREATED);
 * fsm.transition(DiscoveryState.PENDING);
 * fsm.transition(DiscoveryState.SEARCHING);
 * fsm.transition(DiscoveryState.RESOLVED, { reason: "found" });
 * fsm.state; // "resolved"
 * ```
 */
export class DiscoveryLifecycle {
  /** @param {string} [initial=DiscoveryState.CREATED] @param {{ clock?: () => number, history?: object[] }} [options] */
  constructor(initial = DiscoveryState.CREATED, options = {}) {
    if (!(initial in ALLOWED_DISCOVERY_TRANSITIONS)) {
      throw new InvalidDiscoveryTransitionError(`Unknown initial discovery state "${initial}"`, { details: { initial } });
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
    return isTerminalDiscoveryState(this._state);
  }
  /** @returns {string[]} */
  get next() {
    return nextDiscoveryStates(this._state);
  }

  /** Whether a transition to `to` is currently legal. @returns {boolean} */
  can(to) {
    return canDiscoveryTransition(this._state, to);
  }

  /**
   * Perform a transition, recording it in history.
   * @param {string} to @param {{ reason?: string }} [meta]
   * @returns {string} the new state @throws {InvalidDiscoveryTransitionError}
   */
  transition(to, meta = {}) {
    assertDiscoveryTransition(this._state, to);
    const entry = { from: this._state, to, at: new Date(this._clock()).toISOString() };
    if (meta.reason !== undefined) entry.reason = meta.reason;
    this._history.push(entry);
    this._state = to;
    return this._state;
  }
}

/**
 * @module pdp/workflow/lifecycle
 *
 * The deterministic finite state machine governing a PDP session's lifecycle. Defines the legal
 * transitions between {@link PdpState}s and validates every transition the
 * {@link module:pdp/manager} performs. Pure logic — no I/O, no crypto, no transport.
 *
 * A successful run walks `CREATED → RESOLVING → NEGOTIATING → PLANNING → COMPLETED`. Any live stage
 * can fail, cancel, or expire. A recoverable failure can enter `RECOVERY` and re-run from
 * `RESOLVING`.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> created
 *   created --> resolving
 *   resolving --> negotiating
 *   negotiating --> planning
 *   planning --> completed
 *   created --> failed
 *   resolving --> failed
 *   negotiating --> failed
 *   planning --> failed
 *   created --> cancelled
 *   resolving --> cancelled
 *   negotiating --> cancelled
 *   planning --> cancelled
 *   created --> expired
 *   resolving --> expired
 *   negotiating --> expired
 *   planning --> expired
 *   failed --> recovery
 *   recovery --> resolving
 *   recovery --> failed
 *   completed --> [*]
 *   failed --> [*]
 *   cancelled --> [*]
 *   expired --> [*]
 * ```
 */

import { PdpState, ALL_PDP_STATES, isTerminalPdpState } from "../types/types.js";
import { InvalidPdpTransitionError } from "../errors.js";

/**
 * Legal transitions keyed by source state.
 * @type {Readonly<Record<string, string[]>>}
 */
export const ALLOWED_PDP_TRANSITIONS = Object.freeze({
  [PdpState.CREATED]: [PdpState.RESOLVING, PdpState.FAILED, PdpState.CANCELLED, PdpState.EXPIRED],
  [PdpState.RESOLVING]: [PdpState.NEGOTIATING, PdpState.FAILED, PdpState.CANCELLED, PdpState.EXPIRED],
  [PdpState.NEGOTIATING]: [PdpState.PLANNING, PdpState.FAILED, PdpState.CANCELLED, PdpState.EXPIRED],
  [PdpState.PLANNING]: [PdpState.COMPLETED, PdpState.FAILED, PdpState.CANCELLED, PdpState.EXPIRED],
  [PdpState.COMPLETED]: [],
  // A failed workflow can be recovered (retried) once; recovery re-enters RESOLVING.
  [PdpState.FAILED]: [PdpState.RECOVERY],
  [PdpState.RECOVERY]: [PdpState.RESOLVING, PdpState.FAILED, PdpState.CANCELLED, PdpState.EXPIRED],
  [PdpState.CANCELLED]: [],
  [PdpState.EXPIRED]: [],
});

/** Whether `from -> to` is a legal transition. @returns {boolean} */
export function canPdpTransition(from, to) {
  return (ALLOWED_PDP_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a transition is legal. @throws {InvalidPdpTransitionError} */
export function assertPdpTransition(from, to) {
  if (!canPdpTransition(from, to)) {
    throw new InvalidPdpTransitionError(`Cannot transition PDP session from "${from}" to "${to}"`, {
      details: { from, to, allowed: ALLOWED_PDP_TRANSITIONS[from] ?? [] },
    });
  }
}

/** States reachable in one legal step from `state`. @returns {string[]} */
export function nextPdpStates(state) {
  return [...(ALLOWED_PDP_TRANSITIONS[state] ?? [])];
}

/**
 * A small stateful wrapper for driving one PDP session's lifecycle + recording history. Holds no
 * I/O; the manager persists the state.
 *
 * @example
 * ```js
 * const fsm = new PdpLifecycle(PdpState.CREATED);
 * fsm.transition(PdpState.RESOLVING);
 * fsm.transition(PdpState.NEGOTIATING);
 * fsm.transition(PdpState.PLANNING);
 * fsm.transition(PdpState.COMPLETED);
 * ```
 */
export class PdpLifecycle {
  /** @param {string} [initial=PdpState.CREATED] @param {{ clock?: () => number, history?: object[] }} [options] */
  constructor(initial = PdpState.CREATED, options = {}) {
    if (!ALL_PDP_STATES.includes(initial)) {
      throw new InvalidPdpTransitionError(`Unknown initial PDP state "${initial}"`, { details: { initial } });
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
    return isTerminalPdpState(this._state);
  }
  /** @returns {string[]} */
  get next() {
    return nextPdpStates(this._state);
  }

  /** Whether a transition to `to` is currently legal. @returns {boolean} */
  can(to) {
    return canPdpTransition(this._state, to);
  }

  /**
   * Perform a transition, recording it in history.
   * @param {string} to @param {{ reason?: string }} [meta]
   * @returns {string} the new state @throws {InvalidPdpTransitionError}
   */
  transition(to, meta = {}) {
    assertPdpTransition(this._state, to);
    const entry = { from: this._state, to, at: new Date(this._clock()).toISOString() };
    if (meta.reason !== undefined) entry.reason = meta.reason;
    this._history.push(entry);
    this._state = to;
    return this._state;
  }
}

/**
 * @module shs/session/lifecycle
 *
 * The deterministic finite state machine governing a Secure Session's lifecycle.
 * Defines the legal transitions between {@link SessionState}s and validates every
 * transition the manager performs. Pure logic — no I/O, no crypto.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> created
 *   created --> active
 *   created --> failed
 *   created --> invalid
 *   active --> idle
 *   active --> paused
 *   active --> expired
 *   active --> closed
 *   active --> destroyed
 *   active --> invalid
 *   idle --> active
 *   idle --> resumed
 *   idle --> expired
 *   idle --> closed
 *   idle --> destroyed
 *   paused --> resumed
 *   paused --> expired
 *   paused --> closed
 *   paused --> destroyed
 *   resumed --> active
 *   resumed --> idle
 *   resumed --> expired
 *   resumed --> closed
 *   expired --> closed
 *   expired --> destroyed
 *   closed --> destroyed
 *   invalid --> destroyed
 *   invalid --> failed
 *   failed --> destroyed
 *   destroyed --> [*]
 * ```
 */

import { SessionState, isTerminalSessionState } from "../types.js";
import { InvalidSessionTransitionError } from "../errors.js";

/**
 * Legal transitions keyed by source state. `DESTROYED` is fully terminal.
 * @type {Readonly<Record<string, string[]>>}
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [SessionState.CREATED]: [SessionState.ACTIVE, SessionState.FAILED, SessionState.INVALID, SessionState.DESTROYED],
  [SessionState.ACTIVE]: [
    SessionState.IDLE,
    SessionState.PAUSED,
    SessionState.EXPIRED,
    SessionState.CLOSED,
    SessionState.DESTROYED,
    SessionState.INVALID,
  ],
  [SessionState.IDLE]: [
    SessionState.ACTIVE,
    SessionState.RESUMED,
    SessionState.EXPIRED,
    SessionState.CLOSED,
    SessionState.DESTROYED,
    SessionState.INVALID,
  ],
  [SessionState.PAUSED]: [
    SessionState.RESUMED,
    SessionState.EXPIRED,
    SessionState.CLOSED,
    SessionState.DESTROYED,
    SessionState.INVALID,
  ],
  [SessionState.RESUMED]: [
    SessionState.ACTIVE,
    SessionState.IDLE,
    SessionState.EXPIRED,
    SessionState.CLOSED,
    SessionState.DESTROYED,
  ],
  [SessionState.EXPIRED]: [SessionState.CLOSED, SessionState.DESTROYED],
  [SessionState.CLOSED]: [SessionState.DESTROYED],
  [SessionState.INVALID]: [SessionState.DESTROYED, SessionState.FAILED],
  [SessionState.FAILED]: [SessionState.DESTROYED],
  [SessionState.DESTROYED]: [],
});

/** Whether `from -> to` is a legal transition. @returns {boolean} */
export function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a transition is legal. @throws {InvalidSessionTransitionError} */
export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new InvalidSessionTransitionError(`Cannot transition session from "${from}" to "${to}"`, {
      details: { from, to, allowed: ALLOWED_TRANSITIONS[from] ?? [] },
    });
  }
}

/** States reachable in one legal step from `state`. */
export function nextStates(state) {
  return [...(ALLOWED_TRANSITIONS[state] ?? [])];
}

/**
 * A small stateful wrapper for driving a single session's lifecycle + recording its
 * transition history. Holds no I/O; the manager persists the resulting state.
 *
 * @example
 * ```js
 * const fsm = new SessionLifecycle(SessionState.CREATED);
 * fsm.transition(SessionState.ACTIVE);
 * fsm.transition(SessionState.IDLE, { reason: "idle-timeout" });
 * fsm.state; // "idle"
 * ```
 */
export class SessionLifecycle {
  /** @param {string} [initial=SessionState.CREATED] @param {{ clock?: () => number, history?: object[] }} [options] */
  constructor(initial = SessionState.CREATED, options = {}) {
    if (!(initial in ALLOWED_TRANSITIONS)) {
      throw new InvalidSessionTransitionError(`Unknown initial state "${initial}"`, { details: { initial } });
    }
    this._state = initial;
    this._clock = options.clock ?? (() => Date.now());
    this._history = options.history ? [...options.history] : [];
  }

  get state() {
    return this._state;
  }
  get history() {
    return [...this._history];
  }
  get isTerminal() {
    return isTerminalSessionState(this._state);
  }
  get next() {
    return nextStates(this._state);
  }

  can(to) {
    return canTransition(this._state, to);
  }

  /** Perform a transition, recording it. @returns {string} the new state @throws {InvalidSessionTransitionError} */
  transition(to, meta = {}) {
    assertTransition(this._state, to);
    const entry = { from: this._state, to, at: new Date(this._clock()).toISOString() };
    if (meta.reason !== undefined) entry.reason = meta.reason;
    this._history.push(entry);
    this._state = to;
    return this._state;
  }
}

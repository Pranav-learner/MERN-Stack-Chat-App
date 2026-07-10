/**
 * @module shs/state-machine
 *
 * The deterministic finite state machine (FSM) at the heart of the Secure
 * Handshake Protocol. It defines the legal lifecycle transitions between
 * {@link HandshakeState}s and validates every transition the manager performs.
 *
 * The machine is **deterministic**: from a given state, a given transition either
 * has exactly one legal target or is rejected. Terminal states have no outgoing
 * transitions. This module holds NO cryptography and NO I/O — it is pure logic and
 * is the single source of truth for "what states can follow what".
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> created
 *   created --> initialized
 *   created --> cancelled
 *   created --> aborted
 *   initialized --> waiting
 *   initialized --> negotiating
 *   initialized --> cancelled
 *   initialized --> failed
 *   initialized --> timed_out
 *   initialized --> expired
 *   initialized --> aborted
 *   waiting --> negotiating
 *   waiting --> rejected
 *   waiting --> cancelled
 *   waiting --> timed_out
 *   waiting --> expired
 *   waiting --> failed
 *   waiting --> aborted
 *   negotiating --> completed
 *   negotiating --> rejected
 *   negotiating --> failed
 *   negotiating --> cancelled
 *   negotiating --> timed_out
 *   negotiating --> expired
 *   negotiating --> aborted
 *   completed --> [*]
 *   failed --> [*]
 *   cancelled --> [*]
 *   rejected --> [*]
 *   expired --> [*]
 *   timed_out --> [*]
 *   aborted --> [*]
 * ```
 */

import { HandshakeState, TERMINAL_HANDSHAKE_STATES, isTerminalState } from "../types.js";
import { InvalidStateTransitionError } from "../errors.js";

/**
 * Legal transitions, keyed by source state. Terminal states map to `[]`.
 *
 * Design notes:
 * - `EXPIRED`, `TIMED_OUT` and `ABORTED` are reachable from every active state so
 *   the timeout/expiry/recovery framework can always terminate a live handshake.
 * - Terminal states are truly terminal; a "restart" produces a NEW session that
 *   references the old one (see {@link module:shs/manager}) rather than reviving it.
 * @type {Readonly<Record<string, string[]>>}
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [HandshakeState.CREATED]: [
    HandshakeState.INITIALIZED,
    HandshakeState.CANCELLED,
    HandshakeState.ABORTED,
  ],
  [HandshakeState.INITIALIZED]: [
    HandshakeState.WAITING,
    HandshakeState.NEGOTIATING,
    HandshakeState.CANCELLED,
    HandshakeState.FAILED,
    HandshakeState.TIMED_OUT,
    HandshakeState.EXPIRED,
    HandshakeState.ABORTED,
  ],
  [HandshakeState.WAITING]: [
    HandshakeState.NEGOTIATING,
    HandshakeState.REJECTED,
    HandshakeState.CANCELLED,
    HandshakeState.FAILED,
    HandshakeState.TIMED_OUT,
    HandshakeState.EXPIRED,
    HandshakeState.ABORTED,
  ],
  [HandshakeState.NEGOTIATING]: [
    HandshakeState.COMPLETED,
    HandshakeState.REJECTED,
    HandshakeState.FAILED,
    HandshakeState.CANCELLED,
    HandshakeState.TIMED_OUT,
    HandshakeState.EXPIRED,
    HandshakeState.ABORTED,
  ],
  // Terminal states — no outgoing transitions.
  [HandshakeState.COMPLETED]: [],
  [HandshakeState.FAILED]: [],
  [HandshakeState.CANCELLED]: [],
  [HandshakeState.EXPIRED]: [],
  [HandshakeState.TIMED_OUT]: [],
  [HandshakeState.REJECTED]: [],
  [HandshakeState.ABORTED]: [],
});

/**
 * Whether `from -> to` is a legal transition. A self-transition (`from === to`) is
 * NOT legal here (the manager treats no-ops separately) unless the state permits it.
 * @param {string} from @param {string} to @returns {boolean}
 */
export function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Assert a transition is legal, throwing otherwise.
 * @param {string} from @param {string} to
 * @throws {InvalidStateTransitionError}
 */
export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new InvalidStateTransitionError(`Cannot transition handshake from "${from}" to "${to}"`, {
      details: { from, to, allowed: ALLOWED_TRANSITIONS[from] ?? [] },
    });
  }
}

/** The set of states reachable in one legal step from `state`. */
export function nextStates(state) {
  return [...(ALLOWED_TRANSITIONS[state] ?? [])];
}

/**
 * A tiny stateful wrapper around the transition table. Useful for driving a single
 * handshake's state deterministically and recording its history. Holds no I/O; the
 * manager persists the resulting state/history.
 *
 * @example
 * ```js
 * const fsm = new HandshakeStateMachine(HandshakeState.CREATED);
 * fsm.transition(HandshakeState.INITIALIZED);
 * fsm.transition(HandshakeState.WAITING, { reason: "request-sent" });
 * fsm.state;   // "waiting"
 * fsm.history; // [{ from, to, at, reason }, ...]
 * ```
 */
export class HandshakeStateMachine {
  /**
   * @param {string} [initial=HandshakeState.CREATED]
   * @param {{ clock?: () => number, history?: Array<object> }} [options]
   */
  constructor(initial = HandshakeState.CREATED, options = {}) {
    if (!(initial in ALLOWED_TRANSITIONS)) {
      throw new InvalidStateTransitionError(`Unknown initial state "${initial}"`, { details: { initial } });
    }
    this._state = initial;
    this._clock = options.clock ?? (() => Date.now());
    /** @type {Array<{ from: string, to: string, at: string, reason?: string }>} */
    this._history = options.history ? [...options.history] : [];
  }

  /** Current state. */
  get state() {
    return this._state;
  }

  /** A copy of the transition history. */
  get history() {
    return [...this._history];
  }

  /** Whether the machine is in a terminal state. */
  get isTerminal() {
    return isTerminalState(this._state);
  }

  /** States reachable in one step from the current state. */
  get next() {
    return nextStates(this._state);
  }

  /** Whether `to` is reachable in one step from the current state. */
  can(to) {
    return canTransition(this._state, to);
  }

  /**
   * Perform a transition, recording it in history.
   * @param {string} to @param {{ reason?: string }} [meta]
   * @returns {string} the new state
   * @throws {InvalidStateTransitionError}
   */
  transition(to, meta = {}) {
    assertTransition(this._state, to);
    const entry = { from: this._state, to, at: new Date(this._clock()).toISOString() };
    if (meta.reason !== undefined) entry.reason = meta.reason;
    this._history.push(entry);
    this._state = to;
    return this._state;
  }
}

export { HandshakeState, TERMINAL_HANDSHAKE_STATES };

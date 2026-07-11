/**
 * @module synchronization/sessions
 *
 * The deterministic finite state machine governing a **synchronization session**. Pure logic — no I/O.
 * The {@link module:synchronization/manager manager} validates every transition through here.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> created
 *   created --> running
 *   running --> paused
 *   paused --> running: resume
 *   running --> completed
 *   running --> failed
 *   running --> cancelled
 *   created --> cancelled
 *   paused --> cancelled
 *   running --> expired
 *   paused --> expired
 *   completed --> [*]
 *   failed --> [*]
 *   cancelled --> [*]
 *   expired --> [*]
 * ```
 */

import { SyncSessionState, ALL_SESSION_STATES, isTerminalSessionState } from "../types/types.js";
import { InvalidSessionTransitionError } from "../errors.js";

/** Legal session transitions keyed by source state. */
export const ALLOWED_TRANSITIONS = Object.freeze({
  // CREATED → COMPLETED: an empty delta (nothing to sync) completes immediately.
  [SyncSessionState.CREATED]: [SyncSessionState.RUNNING, SyncSessionState.COMPLETED, SyncSessionState.CANCELLED, SyncSessionState.EXPIRED, SyncSessionState.FAILED],
  [SyncSessionState.RUNNING]: [SyncSessionState.PAUSED, SyncSessionState.COMPLETED, SyncSessionState.CANCELLED, SyncSessionState.EXPIRED, SyncSessionState.FAILED],
  [SyncSessionState.PAUSED]: [SyncSessionState.RUNNING, SyncSessionState.CANCELLED, SyncSessionState.EXPIRED, SyncSessionState.FAILED],
  [SyncSessionState.COMPLETED]: [],
  [SyncSessionState.CANCELLED]: [],
  [SyncSessionState.EXPIRED]: [],
  [SyncSessionState.FAILED]: [],
});

/** Whether `from -> to` is legal (self-transition allowed — idempotent). */
export function canTransition(from, to) {
  if (from === to) return true;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a transition. @throws {InvalidSessionTransitionError} */
export function assertTransition(from, to) {
  if (!ALL_SESSION_STATES.includes(to)) throw new InvalidSessionTransitionError(`Unknown session state "${to}"`, { details: { from, to } });
  if (!canTransition(from, to)) throw new InvalidSessionTransitionError(`Cannot transition session from "${from}" to "${to}"`, { details: { from, to, allowed: ALLOWED_TRANSITIONS[from] ?? [] } });
}

/** States reachable in one step. */
export function nextStates(state) {
  return [...(ALLOWED_TRANSITIONS[state] ?? [])];
}

/** A small stateful session-lifecycle driver that records history. */
export class SessionLifecycle {
  constructor(initial = SyncSessionState.CREATED, options = {}) {
    if (!ALL_SESSION_STATES.includes(initial)) throw new InvalidSessionTransitionError(`Unknown initial state "${initial}"`, { details: { initial } });
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
  can(to) {
    return canTransition(this._state, to);
  }
  transition(to, meta = {}) {
    assertTransition(this._state, to);
    const entry = { from: this._state, to, at: new Date(this._clock()).toISOString() };
    if (meta.reason !== undefined) entry.reason = meta.reason;
    this._history.push(entry);
    this._state = to;
    return this._state;
  }
}

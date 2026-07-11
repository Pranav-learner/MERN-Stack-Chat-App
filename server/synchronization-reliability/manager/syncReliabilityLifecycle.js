/**
 * @module synchronization-reliability/manager/lifecycle
 *
 * The deterministic finite state machine governing a synchronization's RELIABILITY lifecycle (distinct
 * from the Sprint 1 session FSM — that tracks sync progress; this tracks continuity + health). Pure
 * logic — no I/O. The {@link module:synchronization-reliability/manager manager} validates every
 * transition through here.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> tracking
 *   tracking --> degraded
 *   degraded --> tracking
 *   tracking --> interrupted
 *   degraded --> interrupted
 *   interrupted --> recovering
 *   recovering --> tracking: resumed
 *   recovering --> interrupted: attempt failed
 *   recovering --> failed: exhausted
 *   tracking --> completed
 *   tracking --> abandoned
 *   completed --> [*]
 *   failed --> [*]
 *   abandoned --> [*]
 * ```
 */

import { ReliabilityState, ALL_RELIABILITY_STATES, isTerminalReliabilityState } from "../types/types.js";
import { InvalidReliabilityTransitionError } from "../errors.js";

/** Legal reliability transitions keyed by source state. */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [ReliabilityState.TRACKING]: [ReliabilityState.DEGRADED, ReliabilityState.INTERRUPTED, ReliabilityState.COMPLETED, ReliabilityState.ABANDONED, ReliabilityState.FAILED],
  [ReliabilityState.DEGRADED]: [ReliabilityState.TRACKING, ReliabilityState.INTERRUPTED, ReliabilityState.COMPLETED, ReliabilityState.ABANDONED, ReliabilityState.FAILED],
  [ReliabilityState.INTERRUPTED]: [ReliabilityState.RECOVERING, ReliabilityState.FAILED, ReliabilityState.ABANDONED],
  [ReliabilityState.RECOVERING]: [ReliabilityState.TRACKING, ReliabilityState.DEGRADED, ReliabilityState.INTERRUPTED, ReliabilityState.COMPLETED, ReliabilityState.FAILED, ReliabilityState.ABANDONED],
  [ReliabilityState.COMPLETED]: [],
  [ReliabilityState.FAILED]: [],
  [ReliabilityState.ABANDONED]: [],
});

/** Whether a `from -> to` transition is legal (self-transition allowed — idempotent). */
export function canTransition(from, to) {
  if (from === to) return true;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a transition is legal. @throws {InvalidReliabilityTransitionError} */
export function assertTransition(from, to) {
  if (!ALL_RELIABILITY_STATES.includes(to)) throw new InvalidReliabilityTransitionError(`Unknown reliability state "${to}"`, { details: { from, to } });
  if (!canTransition(from, to)) throw new InvalidReliabilityTransitionError(`Cannot transition sync reliability from "${from}" to "${to}"`, { details: { from, to, allowed: ALLOWED_TRANSITIONS[from] ?? [] } });
}

/** States reachable in one step. */
export function nextStates(state) {
  return [...(ALLOWED_TRANSITIONS[state] ?? [])];
}

/** A small stateful lifecycle driver that records history. */
export class ReliabilityLifecycle {
  constructor(initial = ReliabilityState.TRACKING, options = {}) {
    if (!ALL_RELIABILITY_STATES.includes(initial)) throw new InvalidReliabilityTransitionError(`Unknown initial state "${initial}"`, { details: { initial } });
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
    return isTerminalReliabilityState(this._state);
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

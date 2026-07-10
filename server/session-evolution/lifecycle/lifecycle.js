/**
 * @module session-evolution/lifecycle
 *
 * The deterministic finite state machine governing an evolution record's lifecycle.
 * Defines the legal transitions between {@link EvolutionState}s and validates every
 * transition the {@link module:session-evolution/manager} performs. Pure logic — no
 * I/O, no crypto.
 *
 * A generation advance walks `STABLE|PENDING|SCHEDULED → EVOLVING → EVOLVED → STABLE`.
 * Scheduling walks `STABLE → SCHEDULED → PENDING`. Cancellation returns to `STABLE`.
 * `RETIRED` (session ended) is terminal.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> initialized
 *   initialized --> stable
 *   initialized --> failed
 *   initialized --> retired
 *   stable --> scheduled
 *   stable --> pending
 *   stable --> evolving
 *   stable --> failed
 *   stable --> retired
 *   scheduled --> pending
 *   scheduled --> evolving
 *   scheduled --> cancelled
 *   scheduled --> stable
 *   scheduled --> failed
 *   scheduled --> retired
 *   pending --> evolving
 *   pending --> cancelled
 *   pending --> stable
 *   pending --> failed
 *   pending --> retired
 *   evolving --> evolved
 *   evolving --> failed
 *   evolving --> retired
 *   evolved --> stable
 *   evolved --> retired
 *   cancelled --> stable
 *   cancelled --> scheduled
 *   cancelled --> pending
 *   cancelled --> retired
 *   failed --> stable
 *   failed --> retired
 *   retired --> [*]
 * ```
 */

import { EvolutionState, isTerminalEvolutionState } from "../types/types.js";
import { InvalidEvolutionTransitionError } from "../errors.js";

/**
 * Legal transitions keyed by source state. `RETIRED` is fully terminal.
 * @type {Readonly<Record<string, string[]>>}
 */
export const ALLOWED_EVOLUTION_TRANSITIONS = Object.freeze({
  [EvolutionState.INITIALIZED]: [EvolutionState.STABLE, EvolutionState.FAILED, EvolutionState.RETIRED],
  [EvolutionState.STABLE]: [
    EvolutionState.SCHEDULED,
    EvolutionState.PENDING,
    EvolutionState.EVOLVING,
    EvolutionState.FAILED,
    EvolutionState.RETIRED,
  ],
  [EvolutionState.SCHEDULED]: [
    EvolutionState.PENDING,
    EvolutionState.EVOLVING,
    EvolutionState.CANCELLED,
    EvolutionState.STABLE,
    EvolutionState.FAILED,
    EvolutionState.RETIRED,
  ],
  [EvolutionState.PENDING]: [
    EvolutionState.EVOLVING,
    EvolutionState.CANCELLED,
    EvolutionState.STABLE,
    EvolutionState.FAILED,
    EvolutionState.RETIRED,
  ],
  [EvolutionState.EVOLVING]: [EvolutionState.EVOLVED, EvolutionState.FAILED, EvolutionState.RETIRED],
  [EvolutionState.EVOLVED]: [EvolutionState.STABLE, EvolutionState.RETIRED],
  [EvolutionState.CANCELLED]: [
    EvolutionState.STABLE,
    EvolutionState.SCHEDULED,
    EvolutionState.PENDING,
    EvolutionState.RETIRED,
  ],
  [EvolutionState.FAILED]: [EvolutionState.STABLE, EvolutionState.RETIRED],
  [EvolutionState.RETIRED]: [],
});

/** Whether `from -> to` is a legal transition. @returns {boolean} */
export function canEvolutionTransition(from, to) {
  return (ALLOWED_EVOLUTION_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a transition is legal. @throws {InvalidEvolutionTransitionError} */
export function assertEvolutionTransition(from, to) {
  if (!canEvolutionTransition(from, to)) {
    throw new InvalidEvolutionTransitionError(`Cannot transition evolution from "${from}" to "${to}"`, {
      details: { from, to, allowed: ALLOWED_EVOLUTION_TRANSITIONS[from] ?? [] },
    });
  }
}

/** States reachable in one legal step from `state`. */
export function nextEvolutionStates(state) {
  return [...(ALLOWED_EVOLUTION_TRANSITIONS[state] ?? [])];
}

/**
 * A small stateful wrapper for driving a single evolution record's lifecycle and
 * recording its transition history. Holds no I/O; the manager persists the state.
 *
 * @example
 * ```js
 * const fsm = new EvolutionLifecycle(EvolutionState.INITIALIZED);
 * fsm.transition(EvolutionState.STABLE);
 * fsm.transition(EvolutionState.EVOLVING, { reason: "policy" });
 * fsm.transition(EvolutionState.EVOLVED);
 * fsm.state; // "evolved"
 * ```
 */
export class EvolutionLifecycle {
  /** @param {string} [initial=EvolutionState.INITIALIZED] @param {{ clock?: () => number, history?: object[] }} [options] */
  constructor(initial = EvolutionState.INITIALIZED, options = {}) {
    if (!(initial in ALLOWED_EVOLUTION_TRANSITIONS)) {
      throw new InvalidEvolutionTransitionError(`Unknown initial evolution state "${initial}"`, { details: { initial } });
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
    return isTerminalEvolutionState(this._state);
  }
  get next() {
    return nextEvolutionStates(this._state);
  }

  can(to) {
    return canEvolutionTransition(this._state, to);
  }

  /** Perform a transition, recording it. @returns {string} the new state @throws {InvalidEvolutionTransitionError} */
  transition(to, meta = {}) {
    assertEvolutionTransition(this._state, to);
    const entry = { from: this._state, to, at: new Date(this._clock()).toISOString() };
    if (meta.reason !== undefined) entry.reason = meta.reason;
    this._history.push(entry);
    this._state = to;
    return this._state;
  }
}

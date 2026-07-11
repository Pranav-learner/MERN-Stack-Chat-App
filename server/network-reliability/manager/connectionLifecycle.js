/**
 * @module network-reliability/manager/connectionLifecycle
 *
 * The deterministic finite state machine for an active connection's lifecycle (as the reliability
 * layer tracks it). Validates every state transition the {@link module:network-reliability/manager}
 * performs. Pure logic — no I/O, no transport.
 *
 * A connection can degrade + recover repeatedly; `CLOSED`/`FAILED` are terminal. Recovery walks
 * `CONNECTED → DEGRADED/DISCONNECTED → RECONNECTING/RECOVERING → CONNECTED` (session preserved).
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> new
 *   new --> connecting
 *   connecting --> connected
 *   connecting --> failed
 *   connected --> degraded
 *   connected --> disconnected
 *   degraded --> connected
 *   degraded --> disconnected
 *   disconnected --> reconnecting
 *   disconnected --> recovering
 *   reconnecting --> connected
 *   reconnecting --> recovering
 *   reconnecting --> failed
 *   recovering --> connected
 *   recovering --> failed
 *   connected --> closed
 *   degraded --> closed
 *   disconnected --> closed
 *   failed --> [*]
 *   closed --> [*]
 * ```
 */

import { ConnectionState, ALL_CONNECTION_STATES, isTerminalConnectionState } from "../types/types.js";
import { InvalidTransitionError } from "../errors.js";

/** Legal transitions keyed by source state. `close` is always allowed from a non-terminal state. */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [ConnectionState.NEW]: [ConnectionState.CONNECTING, ConnectionState.CONNECTED, ConnectionState.CLOSED, ConnectionState.FAILED],
  [ConnectionState.CONNECTING]: [ConnectionState.CONNECTED, ConnectionState.FAILED, ConnectionState.DISCONNECTED, ConnectionState.CLOSED],
  [ConnectionState.CONNECTED]: [ConnectionState.DEGRADED, ConnectionState.DISCONNECTED, ConnectionState.CLOSED],
  [ConnectionState.DEGRADED]: [ConnectionState.CONNECTED, ConnectionState.DISCONNECTED, ConnectionState.CLOSED],
  // CONNECTED is reachable directly when a spontaneous heartbeat proves the transport came back.
  [ConnectionState.DISCONNECTED]: [ConnectionState.CONNECTED, ConnectionState.RECONNECTING, ConnectionState.RECOVERING, ConnectionState.CLOSED, ConnectionState.FAILED],
  [ConnectionState.RECONNECTING]: [ConnectionState.CONNECTED, ConnectionState.RECOVERING, ConnectionState.DISCONNECTED, ConnectionState.FAILED, ConnectionState.CLOSED],
  [ConnectionState.RECOVERING]: [ConnectionState.CONNECTED, ConnectionState.RECONNECTING, ConnectionState.FAILED, ConnectionState.CLOSED],
  [ConnectionState.FAILED]: [ConnectionState.RECONNECTING, ConnectionState.CLOSED], // a manual reconnect can revive a failed connection
  [ConnectionState.CLOSED]: [],
});

/** Whether `from -> to` is legal (a self-transition is allowed — an idempotent refresh). */
export function canTransition(from, to) {
  if (from === to) return true;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a transition is legal. @throws {InvalidTransitionError} */
export function assertTransition(from, to) {
  if (!ALL_CONNECTION_STATES.includes(to)) {
    throw new InvalidTransitionError(`Unknown connection state "${to}"`, { details: { from, to } });
  }
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(`Cannot transition connection from "${from}" to "${to}"`, {
      details: { from, to, allowed: ALLOWED_TRANSITIONS[from] ?? [] },
    });
  }
}

/** States reachable in one legal step. @returns {string[]} */
export function nextStates(state) {
  return [...(ALLOWED_TRANSITIONS[state] ?? [])];
}

/**
 * A small stateful lifecycle driver (records transition history). Holds no I/O.
 * @example
 * ```js
 * const fsm = new ConnectionLifecycle(ConnectionState.CONNECTED);
 * fsm.transition(ConnectionState.DISCONNECTED);
 * fsm.transition(ConnectionState.RECONNECTING);
 * fsm.transition(ConnectionState.CONNECTED);
 * ```
 */
export class ConnectionLifecycle {
  /** @param {string} [initial] @param {{ clock?: () => number, history?: object[] }} [options] */
  constructor(initial = ConnectionState.NEW, options = {}) {
    if (!ALL_CONNECTION_STATES.includes(initial)) throw new InvalidTransitionError(`Unknown initial state "${initial}"`, { details: { initial } });
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
    return isTerminalConnectionState(this._state);
  }
  get next() {
    return nextStates(this._state);
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

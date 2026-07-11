/**
 * @module data-plane/lifecycle
 *
 * The deterministic finite state machine governing a message's delivery lifecycle. Validates every
 * transition the {@link module:data-plane/manager engine} performs. Pure logic — no I/O, no crypto,
 * no transport.
 *
 * A guaranteed delivery walks `CREATED → QUEUED → SENDING → SENT → (DELIVERED) → ACKNOWLEDGED`. A
 * retransmission loops `SENT → SENDING`. Any active message can fail, expire, or be cancelled.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> created
 *   created --> queued
 *   queued --> sending
 *   sending --> sent
 *   sending --> queued: no connection (requeue)
 *   sent --> sending: retransmit
 *   sent --> delivered
 *   sent --> acknowledged
 *   delivered --> acknowledged
 *   queued --> cancelled
 *   sent --> failed
 *   sent --> expired
 *   queued --> expired
 *   acknowledged --> destroyed
 *   failed --> [*]
 *   expired --> [*]
 *   cancelled --> [*]
 *   destroyed --> [*]
 * ```
 */

import { DeliveryState, ALL_DELIVERY_STATES, isTerminalDeliveryState } from "../types/types.js";
import { InvalidDeliveryTransitionError } from "../errors.js";

/** Legal transitions keyed by source state. */
export const ALLOWED_DELIVERY_TRANSITIONS = Object.freeze({
  [DeliveryState.CREATED]: [DeliveryState.QUEUED, DeliveryState.CANCELLED, DeliveryState.EXPIRED],
  [DeliveryState.QUEUED]: [DeliveryState.SENDING, DeliveryState.CANCELLED, DeliveryState.EXPIRED, DeliveryState.FAILED],
  // DELIVERED/ACKNOWLEDGED are reachable directly from SENDING because a fast peer's ACK can arrive
  // while we are still handing the envelope to the transport (a synchronous/loopback transport).
  [DeliveryState.SENDING]: [DeliveryState.SENT, DeliveryState.QUEUED, DeliveryState.DELIVERED, DeliveryState.ACKNOWLEDGED, DeliveryState.FAILED, DeliveryState.EXPIRED],
  // SENT → QUEUED: a retransmission that finds no live connection requeues the message.
  [DeliveryState.SENT]: [DeliveryState.SENDING, DeliveryState.QUEUED, DeliveryState.DELIVERED, DeliveryState.ACKNOWLEDGED, DeliveryState.FAILED, DeliveryState.EXPIRED],
  [DeliveryState.DELIVERED]: [DeliveryState.ACKNOWLEDGED, DeliveryState.EXPIRED],
  [DeliveryState.ACKNOWLEDGED]: [DeliveryState.DESTROYED],
  [DeliveryState.FAILED]: [DeliveryState.DESTROYED],
  [DeliveryState.EXPIRED]: [DeliveryState.DESTROYED],
  [DeliveryState.CANCELLED]: [DeliveryState.DESTROYED],
  [DeliveryState.DESTROYED]: [],
});

/** Whether `from -> to` is legal (a self-transition is allowed — idempotent). */
export function canDeliveryTransition(from, to) {
  if (from === to) return true;
  return (ALLOWED_DELIVERY_TRANSITIONS[from] ?? []).includes(to);
}

/** Assert a transition is legal. @throws {InvalidDeliveryTransitionError} */
export function assertDeliveryTransition(from, to) {
  if (!ALL_DELIVERY_STATES.includes(to)) {
    throw new InvalidDeliveryTransitionError(`Unknown delivery state "${to}"`, { details: { from, to } });
  }
  if (!canDeliveryTransition(from, to)) {
    throw new InvalidDeliveryTransitionError(`Cannot transition message from "${from}" to "${to}"`, {
      details: { from, to, allowed: ALLOWED_DELIVERY_TRANSITIONS[from] ?? [] },
    });
  }
}

/** States reachable in one legal step. @returns {string[]} */
export function nextDeliveryStates(state) {
  return [...(ALLOWED_DELIVERY_TRANSITIONS[state] ?? [])];
}

/**
 * A small stateful lifecycle driver (records transition history). Holds no I/O.
 * @example
 * ```js
 * const fsm = new DeliveryLifecycle();
 * fsm.transition(DeliveryState.QUEUED);
 * fsm.transition(DeliveryState.SENDING);
 * fsm.transition(DeliveryState.SENT);
 * fsm.transition(DeliveryState.ACKNOWLEDGED);
 * ```
 */
export class DeliveryLifecycle {
  /** @param {string} [initial=DeliveryState.CREATED] @param {{ clock?: () => number, history?: object[] }} [options] */
  constructor(initial = DeliveryState.CREATED, options = {}) {
    if (!ALL_DELIVERY_STATES.includes(initial)) throw new InvalidDeliveryTransitionError(`Unknown initial state "${initial}"`, { details: { initial } });
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
    return isTerminalDeliveryState(this._state);
  }
  get next() {
    return nextDeliveryStates(this._state);
  }

  can(to) {
    return canDeliveryTransition(this._state, to);
  }

  transition(to, meta = {}) {
    assertDeliveryTransition(this._state, to);
    const entry = { from: this._state, to, at: new Date(this._clock()).toISOString() };
    if (meta.reason !== undefined) entry.reason = meta.reason;
    this._history.push(entry);
    this._state = to;
    return this._state;
  }
}

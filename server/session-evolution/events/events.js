/**
 * @module session-evolution/events
 *
 * Internal Session Evolution event bus. The {@link module:session-evolution/manager}
 * emits a typed event on every evolution transition — creation, scheduling, policy
 * trigger, generation advance, cancellation, retirement — so future layers (Forward
 * Secrecy, Automatic Rekeying, Ratcheting) can react without polling. Backed by Node's
 * `EventEmitter`; mirrors the SHS / session / transport buses.
 *
 * @security Events carry PUBLIC data only (evolution/session ids, states, generation
 * numbers, policy types, reasons) — never key bytes, shared secrets, or ratchet state.
 */

import { EventEmitter } from "node:events";
import { EvolutionEventType } from "../types/types.js";

/**
 * @typedef {object} EvolutionEvent
 * @property {string} type one of {@link EvolutionEventType}
 * @property {string} evolutionId @property {string} sessionId
 * @property {string} [state] @property {string} [previousState]
 * @property {number} [generation] @property {number} [previousGeneration]
 * @property {string} [policyType] @property {string} [policyId]
 * @property {string} [trigger] @property {string} [reason]
 * @property {object} [details] @property {number} at epoch ms
 */

/** Typed pub/sub bus for evolution events. */
export class EvolutionEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to an evolution event type (or `"*"` for all).
   * @param {string} type @param {(event: EvolutionEvent) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  /** Subscribe once. */
  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /**
   * Emit an evolution event (fires the specific type and the wildcard `"*"`).
   * @param {string} type @param {Omit<EvolutionEvent, "type"|"at">} payload
   */
  emit(type, payload) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { EvolutionEventType };

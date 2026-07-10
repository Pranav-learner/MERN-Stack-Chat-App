/**
 * @module forward-secrecy/events
 *
 * Internal Forward Secrecy event bus. The {@link module:forward-secrecy/manager} emits a
 * typed event for every security-relevant step — evolution start, generation advance,
 * activation, key destruction, evolution completion/failure, policy trigger, transport
 * update — so future layers (Chain Keys, Message Keys) and observers can react. Backed by
 * Node's `EventEmitter`; mirrors the SHS / session / evolution / transport buses.
 *
 * @security Events carry PUBLIC data only (session ids, generation numbers, key ids,
 * fingerprints, reasons) — never key bytes, chain secrets, or shared secrets.
 */

import { EventEmitter } from "node:events";
import { ForwardSecrecyEventType } from "../types/types.js";

/**
 * @typedef {object} ForwardSecrecyEvent
 * @property {string} type one of {@link ForwardSecrecyEventType}
 * @property {string} sessionId @property {number} [generation] @property {number} [previousGeneration]
 * @property {string} [keyId] @property {string} [fingerprint] @property {string} [trigger] @property {string} [reason]
 * @property {object} [details] @property {number} at epoch ms
 */

/** Typed pub/sub bus for forward-secrecy events. */
export class ForwardSecrecyEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to an event type (or `"*"` for all). @returns {() => void} unsubscribe
   * @param {string} type @param {(event: ForwardSecrecyEvent) => void} handler
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
   * Emit an event (fires the specific type and the wildcard `"*"`).
   * @param {string} type @param {Omit<ForwardSecrecyEvent, "type"|"at">} payload
   */
  emit(type, payload) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { ForwardSecrecyEventType };

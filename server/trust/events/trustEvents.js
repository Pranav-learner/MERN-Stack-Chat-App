/**
 * @module trust/events
 *
 * Internal trust event bus. The {@link TrustManager} emits typed events on every
 * verification / trust change so future layers can react (e.g. Secure Handshake
 * refusing to proceed on `identity_changed`). Backed by Node's `EventEmitter`.
 *
 * Events are in-process, best-effort, and carry only PUBLIC data (ids, public
 * fingerprints, safety numbers) — never private material.
 */

import { EventEmitter } from "node:events";
import { TrustEventType } from "../types.js";

/**
 * @typedef {object} TrustEvent
 * @property {string} type one of {@link TrustEventType}
 * @property {string} [verifierUser]
 * @property {string} [subjectUser]
 * @property {object} [details]
 * @property {number} at epoch ms
 */

/** Typed pub/sub bus for trust events. */
export class TrustEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to a trust event type (or `"*"` for all).
   * @param {string} type @param {(event: TrustEvent) => void} handler
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
   * Emit a trust event (fires the specific type and the wildcard `"*"`).
   * @param {string} type @param {Omit<TrustEvent, "type"|"at">} payload
   */
  emit(type, payload) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { TrustEventType };

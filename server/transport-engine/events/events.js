/**
 * @module transport-engine/events
 *
 * Internal transport-engine event bus. The engine emits a typed event on every notable step of a
 * transfer's life — started, fragmented, chunk created/sent/received/acked/retried, progress,
 * paused/resumed, completed/failed/cancelled, window updated, backpressure applied/released — so a
 * FUTURE Layer 11 (media) + the UI can react without polling. Mirrors the data-plane / networking
 * buses.
 *
 * @security Events carry ids + states + counts + byte totals ONLY — never plaintext, ciphertext
 * bytes, or key material.
 */

import { EventEmitter } from "node:events";
import { TransportEventType } from "../types/types.js";

/**
 * @typedef {object} TransportEvent
 * @property {string} type one of {@link TransportEventType}
 * @property {string} [transferId] @property {string} [conversationId] @property {string} [chunkId]
 * @property {number} [index] @property {number} [progress] @property {number} [bytes] @property {string} [state]
 * @property {string} [reason] @property {object} [details] @property {number} at
 */

export class TransportEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /** Subscribe to an event type (or `"*"` for all). @returns {() => void} unsubscribe */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /** Emit an event (fires the specific type + the wildcard `"*"`). */
  emit(type, payload = {}) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { TransportEventType };

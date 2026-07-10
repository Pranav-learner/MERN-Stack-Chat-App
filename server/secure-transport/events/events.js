/**
 * @module secure-transport/events
 *
 * Internal event bus for the Secure Transport Layer. Emits typed events on
 * encrypt/decrypt/relay/failure so observability + future layers can react. Mirrors
 * the other subsystem buses. Public data only (ids, sizes, reasons) — never plaintext,
 * keys, or ciphertext bytes.
 */

import { EventEmitter } from "node:events";
import { SecureTransportEventType } from "../types.js";

/**
 * @typedef {object} SecureTransportEvent
 * @property {string} type one of {@link SecureTransportEventType}
 * @property {string} [sessionId] @property {string} [keyId] @property {string} [messageType]
 * @property {number} [bytes] ciphertext size @property {number} [latencyMs]
 * @property {string} [reason] @property {object} [details] @property {number} at epoch ms
 */

/** Typed pub/sub bus for secure-transport events. */
export class SecureTransportEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to an event type (or `"*"`).
   * @param {string} type @param {(event: SecureTransportEvent) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /** Emit an event (fires the specific type and the wildcard `"*"`). */
  emit(type, payload) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { SecureTransportEventType };

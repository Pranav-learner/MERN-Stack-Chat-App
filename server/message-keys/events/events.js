/**
 * @module message-keys/events
 *
 * Internal event bus for the per-message key engine. Emits a typed event for every message
 * key derivation, use, destruction, and failure so future layers (Sprint 6 hardening, PCS)
 * and observers can react. Backed by Node's `EventEmitter`; mirrors the other layer buses.
 *
 * @security Events carry PUBLIC data only (session ids, message numbers, key ids,
 * fingerprints, generations, directions, reasons) — never key bytes.
 */

import { EventEmitter } from "node:events";
import { MessageKeyEventType } from "../types/types.js";

/**
 * @typedef {object} MessageKeyEvent
 * @property {string} type one of {@link MessageKeyEventType}
 * @property {string} sessionId @property {string} [direction] @property {number} [generation]
 * @property {number} [messageNumber] @property {string} [keyId] @property {string} [fingerprint] @property {string} [reason]
 * @property {object} [details] @property {number} at epoch ms
 */

/** Typed pub/sub bus for message-key events. */
export class MessageKeyEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /** Subscribe (or `"*"` for all). @returns {() => void} unsubscribe */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  /** Subscribe once. */
  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /** Emit an event (fires the specific type + the wildcard `"*"`). */
  emit(type, payload) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { MessageKeyEventType };

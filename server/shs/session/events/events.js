/**
 * @module shs/session/events
 *
 * Internal Secure Session event bus. The {@link SecureSessionManager} emits a typed
 * event on every lifecycle transition + rekey so future layers (encrypted messaging
 * in Layer 5) can react. Backed by Node's `EventEmitter`; mirrors the SHS /
 * key-agreement buses.
 *
 * Events carry PUBLIC data only (session ids, states, key METADATA, reasons) — never
 * key bytes or shared secrets.
 */

import { EventEmitter } from "node:events";
import { SessionEventType } from "../types.js";

/**
 * @typedef {object} SessionEvent
 * @property {string} type one of {@link SessionEventType}
 * @property {string} sessionId @property {string} [handshakeId]
 * @property {string} [state] @property {string} [previousState]
 * @property {number} [generation] @property {string} [reason]
 * @property {object} [details] @property {number} at epoch ms
 */

/** Typed pub/sub bus for session events. */
export class SessionEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to a session event type (or `"*"` for all).
   * @param {string} type @param {(event: SessionEvent) => void} handler
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
   * Emit a session event (fires the specific type and the wildcard `"*"`).
   * @param {string} type @param {Omit<SessionEvent, "type"|"at">} payload
   */
  emit(type, payload) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { SessionEventType };

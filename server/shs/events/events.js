/**
 * @module shs/events
 *
 * Internal handshake event bus. The {@link HandshakeManager} emits a typed event on
 * every lifecycle transition so future layers can react (e.g. a crypto sprint
 * starting ECDH on `handshake.accepted`, or telemetry/auditing). Backed by Node's
 * `EventEmitter`.
 *
 * Events are in-process, best-effort, and carry only PUBLIC data (ids, states,
 * versions, reasons) — never private material or shared secrets.
 */

import { EventEmitter } from "node:events";
import { HandshakeEventType } from "../types.js";

/**
 * @typedef {object} HandshakeEvent
 * @property {string} type one of {@link HandshakeEventType}
 * @property {string} handshakeId
 * @property {string} [initiator]
 * @property {string} [responder]
 * @property {string} [state]
 * @property {string} [previousState]
 * @property {string} [reason]
 * @property {object} [details]
 * @property {number} at epoch ms
 */

/** Typed pub/sub bus for handshake events. */
export class HandshakeEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to a handshake event type (or `"*"` for all).
   * @param {string} type @param {(event: HandshakeEvent) => void} handler
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
   * Emit a handshake event (fires the specific type and the wildcard `"*"`).
   * @param {string} type @param {Omit<HandshakeEvent, "type"|"at">} payload
   */
  emit(type, payload) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { HandshakeEventType };

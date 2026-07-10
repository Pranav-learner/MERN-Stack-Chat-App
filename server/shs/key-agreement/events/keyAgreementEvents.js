/**
 * @module shs/key-agreement/events
 *
 * Internal key-agreement event bus. The {@link KeyAgreementManager} emits a typed
 * event on every step (negotiation, ephemeral key generation, secret derivation,
 * completion/failure) so future layers (session-key derivation, messaging) can react.
 * Backed by Node's `EventEmitter`; mirrors the SHS/Trust event buses.
 *
 * Events carry PUBLIC data only (ids, algorithm, commitments/fingerprints) — never
 * private keys or the shared secret.
 */

import { EventEmitter } from "node:events";
import { KeyAgreementEventType } from "../types.js";

/**
 * @typedef {object} KeyAgreementEvent
 * @property {string} type one of {@link KeyAgreementEventType}
 * @property {string} handshakeId
 * @property {string} [role] @property {string} [algorithm]
 * @property {string} [fingerprint] a secret commitment / key fingerprint (public)
 * @property {string} [reason] @property {object} [details]
 * @property {number} at epoch ms
 */

/** Typed pub/sub bus for key-agreement events. */
export class KeyAgreementEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to an event type (or `"*"` for all).
   * @param {string} type @param {(event: KeyAgreementEvent) => void} handler
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
   * Emit an event (fires the specific type and the wildcard `"*"`).
   * @param {string} type @param {Omit<KeyAgreementEvent, "type"|"at">} payload
   */
  emit(type, payload) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { KeyAgreementEventType };

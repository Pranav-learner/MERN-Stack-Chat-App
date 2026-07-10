/**
 * @module key-hierarchy/events
 *
 * Internal event bus for the key hierarchy. Emits a typed event for every root-key + chain
 * lifecycle transition so future layers (Sprint 5 message keys / ratchet) can react.
 * Backed by Node's `EventEmitter`; mirrors the other layer buses.
 *
 * @security Events carry PUBLIC data only (session ids, key ids, fingerprints, generations,
 * chain indexes, directions, reasons) — never key bytes.
 */

import { EventEmitter } from "node:events";
import { KeyHierarchyEventType } from "../types/types.js";

/**
 * @typedef {object} KeyHierarchyEvent
 * @property {string} type one of {@link KeyHierarchyEventType}
 * @property {string} sessionId @property {number} [generation]
 * @property {string} [rootKeyId] @property {string} [chainId] @property {string} [direction] @property {string} [role]
 * @property {number} [index] @property {string} [fingerprint] @property {string} [reason]
 * @property {object} [details] @property {number} at epoch ms
 */

/** Typed pub/sub bus for key-hierarchy events. */
export class KeyHierarchyEventBus {
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

export { KeyHierarchyEventType };

/**
 * @module replication/events
 *
 * Internal event bus for the State Replication subsystem. The manager emits a typed event on every
 * notable step — replica registered/updated/compared, conflict detected/resolved, merge started/
 * completed, delta replicated, synchronization resumed — so a FUTURE Layer 10 (and the client) can
 * react without polling. Mirrors the synchronization / data-plane buses.
 *
 * @security Events carry ids + versions + counts + policy names ONLY — never plaintext, ciphertext
 * bytes, or key material.
 */

import { EventEmitter } from "node:events";
import { ReplicationEventType } from "../types/types.js";

export class ReplicationEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /** Subscribe to an event type (or `"*"`). @returns {() => void} unsubscribe */
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

export { ReplicationEventType };

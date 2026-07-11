/**
 * @module synchronization/events
 *
 * Internal event bus for the Synchronization Engine. The manager emits a typed event on every notable
 * step — replica registered/updated, sync started/planned, delta generated, progress, paused/resumed,
 * completed/failed/cancelled, operation applied/failed — so a FUTURE Sprint 2 (replication / conflict
 * resolution) + the UI can react without polling. Mirrors the data-plane / reliability buses.
 *
 * @security Events carry ids + versions + counts ONLY — never plaintext, ciphertext bytes, or keys.
 */

import { EventEmitter } from "node:events";
import { SyncEventType } from "../types/types.js";

export class SyncEventBus {
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

export { SyncEventType };

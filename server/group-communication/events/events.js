/**
 * @module group-communication/events
 *
 * Internal event bus for the Group Communication Engine. The engine emits a typed event on every
 * notable step — message sent/received, fan-out started/completed, delivery updated, member rekeyed,
 * group key rotated/expired, replica updated, synchronization started/completed, offline member
 * queued/resumed — so a FUTURE Sprint 4 (Group Delivery & Read Receipt Engine) and the client can react
 * without polling. Mirrors the Sprint-1 group / Layer 8–9 buses.
 *
 * @security Events carry ids + versions + counts + fingerprints ONLY — never message plaintext,
 * ciphertext, or key material.
 */

import { EventEmitter } from "node:events";
import { GroupCommEventType } from "../types/types.js";

export class GroupCommEventBus {
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

export { GroupCommEventType };

/**
 * @module group-receipts/events
 *
 * Internal event bus for the Group Delivery Intelligence subsystem. The manager emits a typed event on
 * every notable step — member delivered/read, receipt/aggregation updated, delivery completed, group
 * fully delivered/read, analytics updated — so the client (live tick updates) + future dashboards can
 * react without polling. Mirrors the group-communication / group-reliability buses.
 *
 * @security Events carry ids + states + counts + ticks ONLY — never message plaintext, ciphertext, or
 * key material.
 */

import { EventEmitter } from "node:events";
import { ReceiptEventType } from "../types/types.js";

export class GroupReceiptEventBus {
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

export { ReceiptEventType };

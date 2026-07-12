/**
 * @module group-reliability/events
 *
 * Internal event bus for the Group Reliability subsystem. The manager emits a typed event on every
 * notable step — operation registered, checkpoint recorded, state/health changed, interrupted, recovery
 * started/succeeded/failed, resumed, backlog detected, completed/failed, alert raised — so the monitor +
 * a future Sprint 4 (Group Delivery & Read Receipt Engine) can react without polling. Mirrors the
 * synchronization-reliability / group-communication buses.
 *
 * @security Events carry ids + states + numeric aggregates ONLY — never plaintext, message content, or
 * key material.
 */

import { EventEmitter } from "node:events";
import { ReliabilityEventType } from "../types/types.js";

export class GroupReliabilityEventBus {
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

export { ReliabilityEventType };

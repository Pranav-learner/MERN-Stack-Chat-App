/**
 * @module crypto-hardening/events
 *
 * Internal event bus for the hardening subsystem — replay detections, lifecycle
 * verifications, recovery operations, and security alerts. Backed by Node's `EventEmitter`;
 * mirrors the other layer buses.
 *
 * @security Events carry PUBLIC data only (ids, generations, message numbers, reasons,
 * severities) — never key bytes.
 */

import { EventEmitter } from "node:events";
import { HardeningEventType } from "../types/types.js";

/** Typed pub/sub bus for hardening events. */
export class HardeningEventBus {
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

export { HardeningEventType };

/**
 * @module networking-hardening/events
 *
 * Internal Networking Hardening event bus. Recovery, monitoring, consistency, rate-limiting, and
 * circuit-breaking all emit typed events here so external monitoring/alerting and a future Layer 7
 * can subscribe without polling. Mirrors the discovery / presence / capability / crypto-hardening
 * buses.
 *
 * @security Events carry METADATA only (ids, counts, reasons, severities) — never private keys,
 * session keys, message keys, chain keys, or shared secrets.
 */

import { EventEmitter } from "node:events";
import { HardeningEventType } from "../types/types.js";

/**
 * @typedef {object} HardeningEvent
 * @property {string} type one of {@link HardeningEventType}
 * @property {string} [alertType] @property {string} [severity] @property {string} [subsystem]
 * @property {string} [subject] @property {string} [reason] @property {string} [action]
 * @property {number} [count] @property {object} [details] @property {number} at epoch ms
 */

/** Typed pub/sub bus for hardening events. */
export class HardeningEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to a hardening event type (or `"*"` for all).
   * @param {string} type @param {(event: HardeningEvent) => void} handler @returns {() => void} unsubscribe
   */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  /** Subscribe once. @param {string} type @param {(event: HardeningEvent) => void} handler */
  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /**
   * Emit a hardening event (fires the specific type and the wildcard `"*"`).
   * @param {string} type @param {Omit<HardeningEvent, "type"|"at">} [payload]
   */
  emit(type, payload = {}) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { HardeningEventType };

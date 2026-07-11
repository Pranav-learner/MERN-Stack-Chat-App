/**
 * @module network-reliability/events
 *
 * Internal Network Reliability event bus. Connection lifecycle, health, heartbeat, recovery, and
 * alerting all emit typed events here so external monitoring/alerting and a future Layer 8 can
 * subscribe without polling. Mirrors the discovery / presence / hardening buses.
 *
 * @security Events carry CONTROL-PLANE metadata only (connection ids, states, latencies, reasons,
 * severities) — never private keys, session keys, message keys, chain keys, or shared secrets.
 */

import { EventEmitter } from "node:events";
import { ReliabilityEventType } from "../types/types.js";

/**
 * @typedef {object} ReliabilityEvent
 * @property {string} type one of {@link ReliabilityEventType}
 * @property {string} [connectionId] @property {string} [deviceId] @property {string} [peerId]
 * @property {string} [state] @property {string} [previousState] @property {string} [status]
 * @property {string} [trigger] @property {string} [action] @property {string} [alertType]
 * @property {string} [severity] @property {number} [latencyMs] @property {number} [score]
 * @property {number} [count] @property {string} [reason] @property {object} [details] @property {number} at
 */

/** Typed pub/sub bus for reliability events. */
export class ReliabilityEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to a reliability event type (or `"*"` for all).
   * @param {string} type @param {(event: ReliabilityEvent) => void} handler @returns {() => void} unsubscribe
   */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  /** Subscribe once. @param {string} type @param {(event: ReliabilityEvent) => void} handler */
  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /**
   * Emit a reliability event (fires the specific type and the wildcard `"*"`).
   * @param {string} type @param {Omit<ReliabilityEvent, "type"|"at">} [payload]
   */
  emit(type, payload = {}) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { ReliabilityEventType };

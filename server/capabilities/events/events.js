/**
 * @module capabilities/events
 *
 * Internal Capability event bus. The {@link module:capabilities/manager} emits a typed event on
 * every notable action — capabilities registered/updated/refreshed/expired/removed, a negotiation
 * started/succeeded/failed, a preferred transport selected — so future Layer 6/7 sprints (NAT
 * Traversal) can react without polling. Backed by Node's `EventEmitter`; mirrors the discovery /
 * presence / SHS buses.
 *
 * @security Events carry PUBLIC data only (capability/user/device ids, versions, transport names,
 * feature flags, states, reasons) — never private keys, session keys, message keys, chain keys, or
 * shared secrets.
 *
 * @evolution In a distributed deployment this in-process bus is the seam where a fan-out transport
 * (Redis pub/sub, NATS) plugs in — the event shape is transport-agnostic.
 */

import { EventEmitter } from "node:events";
import { CapabilityEventType } from "../types/types.js";

/**
 * @typedef {object} CapabilityEvent
 * @property {string} type one of {@link CapabilityEventType}
 * @property {string} [capabilityId] @property {string} [userId] @property {string} [deviceId]
 * @property {string} [state] @property {string} [previousState] @property {number} [version]
 * @property {string} [preferredTransport] @property {boolean} [compatible]
 * @property {string} [reason] @property {object} [result] @property {object} [details]
 * @property {number} at epoch ms
 */

/** Typed pub/sub bus for capability events. */
export class CapabilityEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to a capability event type (or `"*"` for all).
   * @param {string} type @param {(event: CapabilityEvent) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  /** Subscribe once. @param {string} type @param {(event: CapabilityEvent) => void} handler */
  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /**
   * Emit a capability event (fires the specific type and the wildcard `"*"`).
   * @param {string} type @param {Omit<CapabilityEvent, "type"|"at">} [payload]
   */
  emit(type, payload = {}) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { CapabilityEventType };

/**
 * @module peer-discovery/events
 *
 * Internal Peer Discovery event bus. The {@link module:peer-discovery/manager} emits a
 * typed event on every notable discovery action — a lookup starts, resolves, fails, is
 * cancelled or expires, a result is cached/invalidated, a device is (de)registered — so
 * future Layer 6 sprints (Presence, Capability Exchange, NAT Traversal) can react without
 * polling. Backed by Node's `EventEmitter`; mirrors the SHS / session / evolution buses.
 *
 * @security Events carry PUBLIC data only (discovery/user/device ids, states, lookup
 * types, cache outcomes, reasons, counts) — never private keys, session keys, message
 * keys, chain keys, or shared secrets.
 */

import { EventEmitter } from "node:events";
import { DiscoveryEventType } from "../types/types.js";

/**
 * @typedef {object} DiscoveryEvent
 * @property {string} type one of {@link DiscoveryEventType}
 * @property {string} [discoveryId] @property {string} [requester]
 * @property {string} [targetUser] @property {string} [lookupType]
 * @property {string} [state] @property {string} [previousState]
 * @property {string} [source] one of {@link module:peer-discovery/types.DiscoverySource}
 * @property {string} [reason] @property {number} [deviceCount]
 * @property {string} [userId] @property {string} [deviceId]
 * @property {object} [details] @property {number} at epoch ms
 */

/** Typed pub/sub bus for discovery events. */
export class DiscoveryEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to a discovery event type (or `"*"` for all).
   * @param {string} type @param {(event: DiscoveryEvent) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  /** Subscribe once. @param {string} type @param {(event: DiscoveryEvent) => void} handler */
  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /**
   * Emit a discovery event (fires the specific type and the wildcard `"*"`).
   * @param {string} type @param {Omit<DiscoveryEvent, "type"|"at">} [payload]
   */
  emit(type, payload = {}) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { DiscoveryEventType };

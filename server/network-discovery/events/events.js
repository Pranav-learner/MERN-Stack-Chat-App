/**
 * @module network-discovery/events
 *
 * Internal Network Discovery event bus. The {@link module:network-discovery/manager} emits a typed
 * event on every notable step — discovery started, profile created/refreshed, NAT detected, STUN
 * resolved/failed, candidate gathered/expired, network changed — so a FUTURE ICE sprint + observers
 * can react without polling. Mirrors the discovery / presence / capability / PDP buses.
 *
 * @security Events carry PUBLIC addressing metadata only (ids, ip/port/nat-type, counts, reasons) —
 * never private keys, session keys, message keys, chain keys, or shared secrets.
 */

import { EventEmitter } from "node:events";
import { DiscoveryEventType } from "../types/types.js";

/**
 * @typedef {object} DiscoveryEvent
 * @property {string} type one of {@link DiscoveryEventType}
 * @property {string} [profileId] @property {string} [deviceId] @property {string} [userId]
 * @property {string} [natType] @property {string} [publicAddress] @property {string} [server]
 * @property {number} [count] @property {number} [latencyMs] @property {string} [reason]
 * @property {object} [details] @property {number} at epoch ms
 */

/** Typed pub/sub bus for network-discovery events. */
export class DiscoveryEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to an event type (or `"*"` for all).
   * @param {string} type @param {(event: DiscoveryEvent) => void} handler @returns {() => void} unsubscribe
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
   * Emit an event (fires the specific type and the wildcard `"*"`).
   * @param {string} type @param {Omit<DiscoveryEvent, "type"|"at">} [payload]
   */
  emit(type, payload = {}) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { DiscoveryEventType };

/**
 * @module presence/events
 *
 * Internal Presence event bus. The {@link module:presence/manager} emits a typed event on
 * every notable presence action — a device registers, updates status, goes online/offline,
 * is advertised, sends or misses a heartbeat, recovers, or expires — so future Layer 6 sprints
 * (Capability Exchange, NAT Traversal) and the socket layer can react without polling. Backed
 * by Node's `EventEmitter`; mirrors the discovery / SHS / session buses.
 *
 * @security Events carry PUBLIC data only (presence/user/device ids, statuses, timestamps,
 * counts, reasons) — never private keys, session keys, message keys, chain keys, or shared
 * secrets.
 *
 * @evolution In a distributed deployment this in-process bus is the seam where a fan-out
 * transport (Redis pub/sub, NATS, a message bus) plugs in: mirror `emit()` onto the external
 * channel and re-`emit()` remote events locally. The event shape is transport-agnostic.
 */

import { EventEmitter } from "node:events";
import { PresenceEventType } from "../types/types.js";

/**
 * @typedef {object} PresenceEvent
 * @property {string} type one of {@link PresenceEventType}
 * @property {string} [presenceId] @property {string} [userId] @property {string} [deviceId]
 * @property {string} [status] @property {string} [previousStatus]
 * @property {string} [reason] @property {number} [missedHeartbeats]
 * @property {object} [advertisement] @property {object} [details] @property {number} at epoch ms
 */

/** Typed pub/sub bus for presence events. */
export class PresenceEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to a presence event type (or `"*"` for all).
   * @param {string} type @param {(event: PresenceEvent) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  /** Subscribe once. @param {string} type @param {(event: PresenceEvent) => void} handler */
  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /**
   * Emit a presence event (fires the specific type and the wildcard `"*"`).
   * @param {string} type @param {Omit<PresenceEvent, "type"|"at">} [payload]
   */
  emit(type, payload = {}) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { PresenceEventType };

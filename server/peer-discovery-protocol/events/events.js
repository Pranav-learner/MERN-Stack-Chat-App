/**
 * @module pdp/events
 *
 * Internal Peer Discovery Protocol event bus. The {@link module:pdp/manager} emits a typed event on
 * every notable step — a discovery is requested, each stage resolves, a device is selected, a
 * connection plan is created, the workflow completes/fails/recovers — so future Layer 7 (NAT
 * Traversal) and observers can react without polling. Backed by Node's `EventEmitter`; mirrors the
 * discovery / presence / capability buses.
 *
 * @security Events carry PUBLIC data only (discovery/user/device ids, states, stages, transports,
 * reasons, counts) — never private keys, session keys, message keys, chain keys, or shared secrets.
 *
 * @evolution In a distributed deployment this in-process bus is the seam where a fan-out transport
 * (Redis pub/sub, NATS) plugs in — the event shape is transport-agnostic.
 */

import { EventEmitter } from "node:events";
import { PdpEventType } from "../types/types.js";

/**
 * @typedef {object} PdpEvent
 * @property {string} type one of {@link PdpEventType}
 * @property {string} [discoveryId] @property {string} [requester] @property {string} [requesterDevice]
 * @property {string} [targetUser] @property {string} [state] @property {string} [previousState]
 * @property {string} [stage] @property {string} [reason] @property {string} [planId]
 * @property {string} [primaryDeviceId] @property {string} [preferredTransport]
 * @property {number} [count] @property {object} [details] @property {number} at epoch ms
 */

/** Typed pub/sub bus for PDP events. */
export class PdpEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to a PDP event type (or `"*"` for all).
   * @param {string} type @param {(event: PdpEvent) => void} handler @returns {() => void} unsubscribe
   */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  /** Subscribe once. @param {string} type @param {(event: PdpEvent) => void} handler */
  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /**
   * Emit a PDP event (fires the specific type and the wildcard `"*"`).
   * @param {string} type @param {Omit<PdpEvent, "type"|"at">} [payload]
   */
  emit(type, payload = {}) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { PdpEventType };

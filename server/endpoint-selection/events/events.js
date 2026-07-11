/**
 * @module endpoint-selection/events
 *
 * Internal Endpoint Selection event bus. The {@link module:endpoint-selection/manager} emits a typed
 * event on every notable step — endpoints ranked, a primary selected, fallbacks generated, routing
 * updated, a policy applied, a plan created/updated, an outcome recorded, a selection failed — so
 * future Layer 7 (NAT Traversal) and observers can react without polling. Mirrors the discovery /
 * presence / capability / PDP buses.
 *
 * @security Events carry PUBLIC data only (plan/user/device ids, scores, policies, transports,
 * reasons) — never private keys, session keys, message keys, chain keys, or shared secrets.
 *
 * @evolution In a distributed deployment this in-process bus is the seam where a fan-out transport
 * (Redis pub/sub, NATS) plugs in — the event shape is transport-agnostic.
 */

import { EventEmitter } from "node:events";
import { EndpointEventType } from "../types/types.js";

/**
 * @typedef {object} EndpointEvent
 * @property {string} type one of {@link EndpointEventType}
 * @property {string} [planId] @property {string} [requester] @property {string} [targetUser]
 * @property {string} [primaryDeviceId] @property {string[]} [priorityOrder] @property {string} [policy]
 * @property {string} [deviceId] @property {string} [outcome] @property {string} [reason]
 * @property {number} [count] @property {object} [details] @property {number} at epoch ms
 */

/** Typed pub/sub bus for endpoint-selection events. */
export class EndpointEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to an event type (or `"*"` for all).
   * @param {string} type @param {(event: EndpointEvent) => void} handler @returns {() => void} unsubscribe
   */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  /** Subscribe once. @param {string} type @param {(event: EndpointEvent) => void} handler */
  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /**
   * Emit an event (fires the specific type and the wildcard `"*"`).
   * @param {string} type @param {Omit<EndpointEvent, "type"|"at">} [payload]
   */
  emit(type, payload = {}) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { EndpointEventType };

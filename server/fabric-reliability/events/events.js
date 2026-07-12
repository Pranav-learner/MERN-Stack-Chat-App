/**
 * @module fabric-reliability/events
 *
 * Internal event bus for the **Production Communication Fabric** reliability layer. Emits a typed event on
 * every notable reliability transition — operation started/succeeded/failed/timed-out/aborted, retry
 * scheduled, circuit opened/half-open/closed, bulkhead rejected, recovery started/completed, graceful
 * degradation, health changed, alert raised, security audited. Mirrors the frozen buses (specific type +
 * wildcard).
 *
 * @evolution A future admin / monitoring UI + external observability pipeline subscribes here. This bus is
 * a frozen, stable extension point (STEP 15).
 *
 * @security Every event carries ids + classifications + numbers only — never plaintext/ciphertext/keys.
 */

import { EventEmitter } from "node:events";
import { ReliabilityEventType } from "../types/types.js";

export class FabricReliabilityEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /** Subscribe to a specific {@link ReliabilityEventType}, or `"*"`. @returns {() => void} unsubscribe */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /** Emit an event. The canonical `type` + `at` always win over any same-named payload field. */
  emit(type, payload = {}) {
    const event = { ...payload, type, at: payload.at ?? Date.now() };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
    return event;
  }
}

export { ReliabilityEventType };

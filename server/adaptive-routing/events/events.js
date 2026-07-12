/**
 * @module adaptive-routing/events
 *
 * Internal event bus for the **Intelligent Routing** subsystem. The engine emits a typed event at every
 * stage — capabilities collected, communication analyzed, network analyzed, policies evaluated, routes
 * scored, strategy selected, fallback generated, execution planned, decision explained. Mirrors the
 * Sprint-1 `FabricEventBus` (specific type + wildcard).
 *
 * @evolution **Sprint 3 (resource optimization / QoS) consumes this bus** to observe scoring + selection
 * and drive global optimization without modifying this pipeline.
 *
 * @security Every event carries ids + classifications + scores only — never plaintext, ciphertext, or keys.
 */

import { EventEmitter } from "node:events";
import { AdaptiveEventType } from "../types/types.js";

export class AdaptiveEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /** Subscribe to a specific {@link AdaptiveEventType}, or `"*"`. @returns {() => void} unsubscribe */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /**
   * Emit an event. The canonical `type` + `at` always win over any same-named payload field (a payload
   * `type` — e.g. the communication type — must never clobber the event's identity).
   */
  emit(type, payload = {}) {
    const event = { ...payload, type, at: payload.at ?? Date.now() };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
    return event;
  }
}

export { AdaptiveEventType };

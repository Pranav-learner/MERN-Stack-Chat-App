/**
 * @module optimization/events
 *
 * Internal event bus for the **Resource Optimization** subsystem. The optimizer emits a typed event at
 * every stage — resources collected, QoS evaluated, policies evaluated, execution scheduled/deferred,
 * resources allocated, devices coordinated, workload balanced, execution started/completed, optimization
 * completed. Mirrors the frozen buses (specific type + wildcard).
 *
 * @evolution **Sprint 4 (production hardening / monitoring / observability) consumes this bus** to observe
 * scheduling + allocation + queue state without modifying this pipeline.
 *
 * @security Every event carries ids + classifications + budget/queue numbers only — never content/keys.
 */

import { EventEmitter } from "node:events";
import { OptimizationEventType } from "../types/types.js";

export class OptimizationEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /** Subscribe to a specific {@link OptimizationEventType}, or `"*"`. @returns {() => void} unsubscribe */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /**
   * Emit an event. The canonical `type` + `at` always win over any same-named payload field.
   */
  emit(type, payload = {}) {
    const event = { ...payload, type, at: payload.at ?? Date.now() };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
    return event;
  }
}

export { OptimizationEventType };

/**
 * @module communication-fabric/events
 *
 * Internal event bus for the **Communication Fabric**. The manager emits a typed event at every stage of
 * the request lifecycle — requested, context built, policies evaluated, decision created, strategy
 * selected, route/execution planned, execution started, per-step started/completed/failed, execution
 * completed/failed. Mirrors the group-communication / media-delivery buses (specific type + wildcard).
 *
 * @evolution **Sprint 2 (intelligent / adaptive routing) consumes this bus** — it observes decisions +
 * step outcomes to feed adaptive scoring WITHOUT modifying the Sprint-1 pipeline. Any future dashboard or
 * optimizer subscribes here rather than being wired into the manager.
 *
 * @security Every emitted event carries ids + classifications + bookkeeping ONLY — never message
 * plaintext, ciphertext, or key material.
 */

import { EventEmitter } from "node:events";
import { FabricEventType } from "../types/types.js";

export class FabricEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to a specific {@link FabricEventType}, or `"*"` for every event.
   * @param {string} type @param {(event: object) => void} handler
   * @returns {() => void} an unsubscribe function
   */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  /** Subscribe once. */
  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /**
   * Emit an event. Fires the specific type AND the wildcard `"*"`. A best-effort stamp `at` is added; the
   * caller supplies `at` for deterministic tests. Never throws to the emitter — listener errors are
   * isolated by the EventEmitter contract of the caller's handlers.
   * @param {string} type @param {object} [payload]
   */
  emit(type, payload = {}) {
    // The canonical event `type` + `at` always win — a payload field named `type`/`at` (e.g. the
    // communication type of the request) must never clobber the event's own identity.
    const event = { ...payload, type, at: payload.at ?? Date.now() };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
    return event;
  }
}

export { FabricEventType };

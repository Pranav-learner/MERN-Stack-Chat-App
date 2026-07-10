/**
 * @module evolution-policy/events
 *
 * Internal event bus for the automatic-rekey engine. Emits a typed event for every
 * evaluation, queue, and execution transition so future layers (Chain Keys, Message Keys)
 * and observers can react. Backed by Node's `EventEmitter`; mirrors the other layer buses.
 *
 * @security Events carry PUBLIC data only (session/execution ids, generation numbers,
 * policy ids/types, triggers, reasons) — never key bytes or secrets.
 */

import { EventEmitter } from "node:events";
import { RekeyEventType } from "../types/types.js";

/**
 * @typedef {object} RekeyEvent
 * @property {string} type one of {@link RekeyEventType}
 * @property {string} sessionId @property {string} [executionId]
 * @property {number} [generation] @property {number} [previousGeneration]
 * @property {string} [policyId] @property {string} [policyType] @property {string} [trigger] @property {string} [reason]
 * @property {object} [details] @property {number} at epoch ms
 */

/** Typed pub/sub bus for rekey events. */
export class RekeyEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /** Subscribe (or `"*"` for all). @returns {() => void} unsubscribe */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  /** Subscribe once. */
  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /** Emit an event (fires the specific type + the wildcard `"*"`). */
  emit(type, payload) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { RekeyEventType };

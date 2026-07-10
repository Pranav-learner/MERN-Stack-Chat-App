/**
 * @module session-integration/events
 *
 * Internal event bus for the Secure Session Integration layer. The pipeline,
 * middleware, and application session manager emit typed events here so observability
 * and future encryption layers can react. Mirrors the SHS / session / hardening buses.
 *
 * @security Public data only (session ids, key METADATA, participant ids, resolution
 * outcomes). No key bytes or message content.
 */

import { EventEmitter } from "node:events";
import { IntegrationEventType } from "../types.js";

/**
 * @typedef {object} IntegrationEvent
 * @property {string} type one of {@link IntegrationEventType}
 * @property {string} [sessionId] @property {string} [initiator] @property {string} [peer]
 * @property {string} [resolution] @property {string} [transportMode]
 * @property {object} [details] @property {number} at epoch ms
 */

/** Typed pub/sub bus for integration events. */
export class SessionIntegrationEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to an integration event type (or `"*"`).
   * @param {string} type @param {(event: IntegrationEvent) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /** Emit an event (fires the specific type and the wildcard `"*"`). */
  emit(type, payload) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { IntegrationEventType };

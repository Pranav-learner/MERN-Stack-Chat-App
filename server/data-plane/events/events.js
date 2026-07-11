/**
 * @module data-plane/events
 *
 * Internal data-plane event bus. The messaging engine emits a typed event on every notable step —
 * message queued/sent/delivered/acknowledged, ACK received/sent, retry scheduled/succeeded/failed,
 * ordering gap/recovered, duplicate detected — so a FUTURE Sprint 2 (fragmentation/flow control) +
 * the UI can react without polling. Mirrors the discovery / presence / reliability buses.
 *
 * @security Events carry ids + states + counts ONLY — never plaintext, ciphertext bytes, or key
 * material.
 */

import { EventEmitter } from "node:events";
import { MessagingEventType } from "../types/types.js";

/**
 * @typedef {object} MessagingEvent
 * @property {string} type one of {@link MessagingEventType}
 * @property {string} [messageId] @property {string} [conversationId] @property {string} [sender] @property {string} [receiver]
 * @property {number} [seq] @property {string} [state] @property {string} [reason] @property {number} [retryCount]
 * @property {object} [details] @property {number} at
 */

/** Typed pub/sub bus for data-plane events. */
export class MessagingEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to an event type (or `"*"` for all).
   * @param {string} type @param {(event: MessagingEvent) => void} handler @returns {() => void} unsubscribe
   */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  /** Subscribe once. */
  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /** Emit an event (fires the specific type and the wildcard `"*"`). */
  emit(type, payload = {}) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { MessagingEventType };

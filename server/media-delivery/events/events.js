/**
 * @module media-delivery/events
 *
 * Internal event bus for the Media Delivery subsystem. The engine emits a typed event on every notable
 * step — streaming started/paused/resumed/seeked/completed, chunk delivered, buffer updated, transfer
 * started/progress/completed/resumed, thumbnail/preview generated, media synchronized/available, offline
 * media queued, transfer optimized — so the client (progressive UI) + a FUTURE Sprint 3 can react
 * without polling. Mirrors the media / group buses.
 *
 * @security Events carry ids + states + chunk indices + counts + sizes ONLY — never media plaintext,
 * ciphertext bytes, or key material.
 */

import { EventEmitter } from "node:events";
import { MediaDeliveryEventType } from "../types/types.js";

export class MediaDeliveryEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /** Subscribe to an event type (or `"*"`). @returns {() => void} unsubscribe */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /** Emit an event (fires the specific type + the wildcard `"*"`). */
  emit(type, payload = {}) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { MediaDeliveryEventType };

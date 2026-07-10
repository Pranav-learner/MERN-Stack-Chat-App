/**
 * @module shs/hardening/events
 *
 * Internal hardening event bus. Replay/downgrade/integrity/recovery/session-guard
 * checks emit typed events here so observability + future monitoring can consume
 * them. Mirrors the SHS / key-agreement / session buses. Public data only.
 */

import { EventEmitter } from "node:events";
import { HardeningEventType } from "../types.js";

/**
 * @typedef {object} HardeningEvent
 * @property {string} type one of {@link HardeningEventType}
 * @property {string} [handshakeId] @property {string} [sessionId]
 * @property {string} [reason] @property {object} [details] @property {number} at epoch ms
 */

/** Typed pub/sub bus for hardening events. */
export class HardeningEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to a hardening event type (or `"*"`).
   * @param {string} type @param {(event: HardeningEvent) => void} handler
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

export { HardeningEventType };

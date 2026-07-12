/**
 * @module group/events
 *
 * Internal event bus for the Group Foundation subsystem. The manager emits a typed event on every
 * notable step — group created/deleted/archived, member invited/joined/left/removed, invitation
 * accepted/rejected, ownership transferred, metadata updated, role/permission changed, version updated,
 * replica updated — so a FUTURE Layer 10 Sprint 2 (secure group messaging) and the client can react
 * without polling. Mirrors the replication / synchronization buses.
 *
 * @security Events carry ids + roles + states + versions + counts ONLY — never message plaintext,
 * ciphertext, or key material.
 */

import { EventEmitter } from "node:events";
import { GroupEventType } from "../types/types.js";

export class GroupEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  /** Subscribe to an event type (or `"*"` for all). @returns {() => void} unsubscribe */
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

export { GroupEventType };

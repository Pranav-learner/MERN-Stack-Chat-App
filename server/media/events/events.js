/**
 * @module media/events
 *
 * Media event bus for the Secure Media Platform (Layer 11).
 */

import { EventEmitter } from "node:events";

export const MediaEventType = Object.freeze({
  MEDIA_UPLOADED: "media.uploaded",
  MEDIA_DOWNLOADED: "media.downloaded",
  MEDIA_DELETED: "media.deleted",
  MEDIA_VERIFIED: "media.verified",
  OPERATION_STARTED: "operation.started",
  OPERATION_CANCELLED: "operation.cancelled",
  OPERATION_COMPLETED: "operation.completed",
  OPERATION_FAILED: "operation.failed",
});

export class MediaEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
  }

  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  once(type, handler) {
    this._emitter.once(type, handler);
  }

  emit(type, payload = {}) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

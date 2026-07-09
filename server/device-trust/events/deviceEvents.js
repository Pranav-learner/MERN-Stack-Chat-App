/**
 * @module device-trust/events
 *
 * Internal device event bus. The {@link DeviceManager} emits typed events on every
 * lifecycle change; future layers subscribe to react (e.g. tear down sessions when
 * a device is revoked). Backed by Node's `EventEmitter`.
 *
 * Events are in-process and best-effort. They are NOT a durable log and carry no
 * private material (payloads are public device DTOs / ids).
 */

import { EventEmitter } from "node:events";
import { DeviceEventType } from "../types.js";

/**
 * @typedef {object} DeviceEvent
 * @property {string} type one of {@link DeviceEventType}
 * @property {string} deviceId
 * @property {string} userId
 * @property {object} [device] the public device DTO (when applicable)
 * @property {object} [details] extra context (e.g. { reason })
 * @property {number} at epoch ms
 */

/**
 * A typed pub/sub bus for device lifecycle events.
 *
 * @example
 * ```js
 * const bus = new DeviceEventBus();
 * bus.on(DeviceEventType.REVOKED, (e) => teardownSessionsFor(e.deviceId));
 * ```
 */
export class DeviceEventBus {
  constructor() {
    this._emitter = new EventEmitter();
    // Avoid unbounded-listener warnings when many subsystems subscribe.
    this._emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to a device event type (or `"*"` for all events).
   * @param {string} type a {@link DeviceEventType} or `"*"`
   * @param {(event: DeviceEvent) => void} handler
   * @returns {() => void} an unsubscribe function
   */
  on(type, handler) {
    this._emitter.on(type, handler);
    return () => this._emitter.off(type, handler);
  }

  /**
   * Subscribe once.
   * @param {string} type
   * @param {(event: DeviceEvent) => void} handler
   */
  once(type, handler) {
    this._emitter.once(type, handler);
  }

  /**
   * Emit a device event. Emits both the specific type and the wildcard `"*"`.
   * @param {string} type
   * @param {Omit<DeviceEvent, "type" | "at">} payload
   */
  emit(type, payload) {
    const event = { type, at: Date.now(), ...payload };
    this._emitter.emit(type, event);
    this._emitter.emit("*", event);
  }
}

export { DeviceEventType };

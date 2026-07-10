/**
 * @module shs/timeout
 *
 * Timeout framework for the handshake lifecycle. Two responsibilities:
 *
 * 1. **Deadline math** (pure): compute per-step and whole-session deadlines and
 *    whether they have elapsed. Used by the manager and validators; no timers.
 * 2. **Scheduling** (optional): a small {@link TimeoutScheduler} that fires a
 *    callback when a step deadline elapses, with injectable timers for testing and
 *    a recovery hook for future network-failure handling.
 *
 * Timers are injected (default: Node `setTimeout`/`clearTimeout`) so the scheduler
 * is fully testable without real time. This module performs NO cryptography.
 */

import { DEFAULT_STEP_TIMEOUT_MS } from "../protocol/constants.js";

/**
 * Compute the deadline (epoch ms) for a step starting now.
 * @param {number} startedAtMs @param {number} [timeoutMs=DEFAULT_STEP_TIMEOUT_MS]
 * @returns {number}
 */
export function deadlineFrom(startedAtMs, timeoutMs = DEFAULT_STEP_TIMEOUT_MS) {
  return startedAtMs + timeoutMs;
}

/** Whether `deadlineMs` has elapsed as of `now`. */
export function isElapsed(deadlineMs, now = Date.now()) {
  return now >= deadlineMs;
}

/** Milliseconds remaining until `deadlineMs` (>= 0). */
export function remainingMs(deadlineMs, now = Date.now()) {
  return Math.max(0, deadlineMs - now);
}

/**
 * A minimal per-key timeout scheduler. Register a handshake's step timeout; the
 * `onTimeout` callback fires once when it elapses unless cleared first. Designed to
 * be optional — the REST flow works purely on deadline math; the scheduler is for
 * environments (sockets, workers) that want push-style expiry.
 *
 * @example
 * ```js
 * const sched = new TimeoutScheduler({ onTimeout: (id) => manager.timeoutHandshake(id) });
 * sched.arm("hs-1", 30_000);
 * sched.clear("hs-1"); // responder replied in time
 * ```
 */
export class TimeoutScheduler {
  /**
   * @param {object} [options]
   * @param {(handshakeId: string, meta: object) => void} [options.onTimeout] fired on elapse
   * @param {(fn: () => void, ms: number) => any} [options.setTimer=setTimeout]
   * @param {(handle: any) => void} [options.clearTimer=clearTimeout]
   * @param {number} [options.defaultTimeoutMs=DEFAULT_STEP_TIMEOUT_MS]
   */
  constructor(options = {}) {
    this.onTimeout = options.onTimeout ?? (() => {});
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    /** @type {Map<string, { handle: any, meta: object }>} */
    this._timers = new Map();
  }

  /**
   * Arm (or re-arm) the timeout for a handshake step.
   * @param {string} handshakeId @param {number} [ms] @param {object} [meta]
   */
  arm(handshakeId, ms = this.defaultTimeoutMs, meta = {}) {
    this.clear(handshakeId);
    const handle = this.setTimer(() => {
      this._timers.delete(handshakeId);
      this.onTimeout(handshakeId, meta);
    }, ms);
    // Do not keep the event loop alive for a pending handshake timeout.
    if (handle && typeof handle.unref === "function") handle.unref();
    this._timers.set(handshakeId, { handle, meta });
  }

  /** Clear a handshake's timer (e.g. it advanced or completed). Returns whether one existed. */
  clear(handshakeId) {
    const entry = this._timers.get(handshakeId);
    if (!entry) return false;
    this.clearTimer(entry.handle);
    this._timers.delete(handshakeId);
    return true;
  }

  /** Whether a timer is currently armed for a handshake. */
  has(handshakeId) {
    return this._timers.has(handshakeId);
  }

  /** Number of armed timers. */
  get size() {
    return this._timers.size;
  }

  /** Clear all timers (e.g. on shutdown). */
  clearAll() {
    for (const { handle } of this._timers.values()) this.clearTimer(handle);
    this._timers.clear();
  }
}

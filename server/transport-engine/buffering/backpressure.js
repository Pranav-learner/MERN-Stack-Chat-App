/**
 * @module transport-engine/buffering
 *
 * **Backpressure + buffering.** Protects both peers from a slow receiver or a memory blow-up: it caps
 * the bytes/chunks a receiver will buffer, detects a slow receiver, and tells the sender to pause (via
 * a 0-window advertisement) and later resume. On the sender, it caps the per-transfer send-queue depth
 * and total in-flight bytes so a burst of large transfers can't exhaust memory.
 *
 * @distributed Backpressure here is a cooperative, application-level signal layered over the reliable
 * stream — orthogonal to (and composed with) transport-level congestion control. It converts
 * "receiver can't keep up" into an explicit pause/resume rather than unbounded buffering.
 */

import {
  DEFAULT_MAX_QUEUE_DEPTH,
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_RECEIVER_WINDOW,
  BackpressureState,
} from "../types/types.js";

/**
 * Tracks a RECEIVER's buffer occupancy + advertises a window. When buffered bytes cross the high-water
 * mark it advertises 0 (pause); when they drain below the low-water mark it re-advertises (resume).
 */
export class ReceiverBackpressure {
  /**
   * @param {object} [options]
   * @param {number} [options.maxBufferedBytes] high-water mark (bytes)
   * @param {number} [options.receiverWindow] the nominal advertised window (chunks)
   * @param {number} [options.lowWaterRatio] fraction of the max at which flow resumes (default 0.5)
   */
  constructor(options = {}) {
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.nominalWindow = options.receiverWindow ?? DEFAULT_RECEIVER_WINDOW;
    this.lowWaterRatio = options.lowWaterRatio ?? 0.5;
    this._buffered = 0;
    this._slow = false; // memory pressure → advertise a smaller (but non-zero) window
    this._paused = false; // EXPLICIT hard pause (API/control) → advertise 0
  }

  get bufferedBytes() {
    return this._buffered;
  }
  get isPaused() {
    return this._paused;
  }
  get isSlow() {
    return this._slow;
  }

  /**
   * Account for bytes entering the receive buffer. Crossing the low-water mark engages a "slow" signal
   * (a REDUCED, never zero, window) — memory pressure paces the sender without ever stalling an
   * in-flight transfer to a hard stop (which could deadlock a single big transfer that only drains on
   * completion). @returns {boolean} whether the slow signal just engaged
   */
  onBuffered(bytes) {
    this._buffered += Math.max(0, bytes);
    const wasSlow = this._slow;
    if (this._buffered >= this.maxBufferedBytes * this.lowWaterRatio) this._slow = true;
    return !wasSlow && this._slow;
  }

  /** Account for bytes leaving the buffer (consumed / reassembled). @returns {boolean} whether it just released */
  onDrained(bytes) {
    this._buffered = Math.max(0, this._buffered - Math.max(0, bytes));
    const wasSlow = this._slow;
    if (this._slow && this._buffered <= this.maxBufferedBytes * this.lowWaterRatio) this._slow = false;
    return wasSlow && !this._slow;
  }

  /** Explicit hard pause / resume (API- or control-driven → advertises a 0 window). */
  pause() {
    this._paused = true;
  }
  resume() {
    this._paused = false;
  }

  /** The window to advertise to the sender right now (0 only on an EXPLICIT pause; else >= 1). */
  advertisedWindow() {
    if (this._paused) return 0;
    const headroom = 1 - this._buffered / this.maxBufferedBytes;
    return Math.max(1, Math.floor(this.nominalWindow * Math.max(0, headroom)));
  }

  get state() {
    if (this._paused) return BackpressureState.PAUSED;
    if (this._slow) return BackpressureState.SLOW;
    return BackpressureState.OK;
  }

  snapshot() {
    return { bufferedBytes: this._buffered, maxBufferedBytes: this.maxBufferedBytes, advertisedWindow: this.advertisedWindow(), slow: this._slow, paused: this._paused, state: this.state };
  }
}

/**
 * Guards a SENDER's resource limits: per-transfer queue depth + total in-flight bytes across all
 * transfers (memory protection). `admit` returns whether a chunk may be queued; a rejection is the
 * cue to pause scheduling rather than buffer unboundedly.
 */
export class SenderResourceGuard {
  /** @param {object} [options] @param {number} [options.maxQueueDepth] @param {number} [options.maxInFlightBytes] */
  constructor(options = {}) {
    this.maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    this.maxInFlightBytes = options.maxInFlightBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this._inFlightBytes = 0;
  }

  get inFlightBytes() {
    return this._inFlightBytes;
  }

  /** Whether the queue may accept another chunk of `bytes`. */
  admit(currentQueueDepth, bytes) {
    return currentQueueDepth < this.maxQueueDepth && this._inFlightBytes + bytes <= this.maxInFlightBytes;
  }

  /** Reserve in-flight bytes when a chunk is sent. */
  reserve(bytes) {
    this._inFlightBytes += Math.max(0, bytes);
  }

  /** Release in-flight bytes when a chunk is ACKed / failed. */
  release(bytes) {
    this._inFlightBytes = Math.max(0, this._inFlightBytes - Math.max(0, bytes));
  }

  snapshot() {
    return { inFlightBytes: this._inFlightBytes, maxInFlightBytes: this.maxInFlightBytes, maxQueueDepth: this.maxQueueDepth };
  }
}

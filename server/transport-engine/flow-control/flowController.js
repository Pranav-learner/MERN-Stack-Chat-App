/**
 * @module transport-engine/flow-control
 *
 * **Application-level flow control** — a per-transfer sliding window that bounds the number of
 * outstanding (sent-but-un-ACKed) chunks. The effective window is `min(sendWindow, receiverWindow)`:
 * the sender never has more than that many chunks in flight, which paces transmission to what the
 * receiver can absorb.
 *
 * @distributed This is APPLICATION-level pacing over a reliable stream — it does NOT replace TCP/QUIC
 * congestion control (which still runs underneath). Adaptive-window + congestion-awareness are
 * PLACEHOLDER hooks here (they return the static window); a future sprint can plug in AIMD/BBR-style
 * adaptation without changing callers.
 *
 * @example
 * ```js
 * const fc = new FlowController({ windowSize: 8 });
 * while (fc.canSend()) { const c = pickChunk(); fc.onSent(c.chunkId); transport.send(c); }
 * // on ack: fc.onAcked(chunkId) → frees a slot
 * ```
 */

import { DEFAULT_WINDOW_SIZE, DEFAULT_RECEIVER_WINDOW, MIN_WINDOW_SIZE, MAX_WINDOW_SIZE, BackpressureState } from "../types/types.js";

export class FlowController {
  /**
   * @param {object} [options]
   * @param {number} [options.windowSize] the sender's max outstanding chunks
   * @param {number} [options.receiverWindow] the receiver-advertised window
   */
  constructor(options = {}) {
    this._window = clampWindow(options.windowSize ?? DEFAULT_WINDOW_SIZE);
    this._receiverWindow = Math.max(0, options.receiverWindow ?? DEFAULT_RECEIVER_WINDOW);
    /** @type {Set<string>} outstanding (sent, un-ACKed) chunk ids */
    this._outstanding = new Set();
    this._paused = false;
  }

  /** The effective window (min of sender + receiver windows). */
  get effectiveWindow() {
    return Math.min(this._window, this._receiverWindow);
  }
  get outstanding() {
    return this._outstanding.size;
  }
  get windowSize() {
    return this._window;
  }
  get receiverWindow() {
    return this._receiverWindow;
  }
  get isPaused() {
    return this._paused;
  }

  /** Free capacity in the window right now (0 when paused / full). */
  get available() {
    if (this._paused) return 0;
    return Math.max(0, this.effectiveWindow - this._outstanding.size);
  }

  /** Whether another chunk may be sent now. */
  canSend() {
    return this.available > 0;
  }

  /** Record a chunk as sent (occupies a window slot). */
  onSent(chunkId) {
    this._outstanding.add(String(chunkId));
  }

  /** Record a chunk as acknowledged (frees a slot). @returns {boolean} whether it was outstanding */
  onAcked(chunkId) {
    return this._outstanding.delete(String(chunkId));
  }

  /** Whether a chunk is currently outstanding. */
  isOutstanding(chunkId) {
    return this._outstanding.has(String(chunkId));
  }

  /** Apply a receiver-advertised window (backpressure). */
  setReceiverWindow(n) {
    this._receiverWindow = Math.max(0, Math.floor(n));
  }

  /** Resize the sender window (e.g. adaptive control). */
  setWindowSize(n) {
    this._window = clampWindow(n);
  }

  pause() {
    this._paused = true;
  }
  resume() {
    this._paused = false;
  }

  /** The current backpressure posture. */
  get backpressure() {
    if (this._paused || this._receiverWindow === 0) return BackpressureState.PAUSED;
    if (this._outstanding.size >= this.effectiveWindow) return BackpressureState.SLOW;
    return BackpressureState.OK;
  }

  // --- adaptive / congestion PLACEHOLDERS (inert; return the static window) ---

  /** PLACEHOLDER: adaptive window sizing. Returns the current window unchanged (no adaptation yet). */
  adaptWindow() {
    return this._window;
  }

  /** PLACEHOLDER: congestion signal. Always `false` — real congestion control lives in the transport. */
  congested() {
    return false;
  }

  /** A snapshot for diagnostics. */
  snapshot() {
    return { windowSize: this._window, receiverWindow: this._receiverWindow, effectiveWindow: this.effectiveWindow, outstanding: this._outstanding.size, available: this.available, paused: this._paused, backpressure: this.backpressure };
  }
}

function clampWindow(n) {
  return Math.min(MAX_WINDOW_SIZE, Math.max(MIN_WINDOW_SIZE, Math.floor(n)));
}

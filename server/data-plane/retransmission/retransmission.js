/**
 * @module data-plane/retransmission
 *
 * The **Retransmission Engine** — decides when + whether to re-send an un-ACKed message. A sent
 * message carries an ACK deadline (`nextRetryAt`); the engine's sweep (or a scheduler) finds messages
 * past their deadline and retransmits them with exponential backoff, up to a max attempt count, until
 * a delivery timeout (TTL) fails them. Retransmission never causes duplicate DELIVERY — the receiver's
 * {@link module:data-plane/delivery/dedupe duplicate cache} recognizes the resend and re-ACKs it.
 *
 * @security Retransmission re-sends the SAME opaque ciphertext envelope — no re-encryption, no
 * plaintext, no keys.
 *
 * @networking Backoff spreads a retry storm; a bounded attempt count + TTL guarantee a message never
 * retries forever.
 */

import {
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_MAX_MS,
  DEFAULT_RETRY_FACTOR,
} from "../types/types.js";

/** Resolve a partial retry policy against the defaults. */
export function resolveRetryPolicy(policy) {
  return {
    ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
    baseMs: DEFAULT_RETRY_BASE_MS,
    maxMs: DEFAULT_RETRY_MAX_MS,
    factor: DEFAULT_RETRY_FACTOR,
    jitter: true,
    ...(policy ?? {}),
  };
}

/**
 * The backoff delay (ms) before the given retry attempt (1-based). Attempt 0 uses the plain ACK
 * timeout; later attempts grow exponentially, capped.
 * @param {number} retryCount how many retries have already happened @param {object} [policy]
 * @returns {number} delay ms
 */
export function computeBackoff(retryCount, policy) {
  const p = resolveRetryPolicy(policy);
  if (retryCount <= 0) return p.ackTimeoutMs;
  let delay = Math.min(p.maxMs, p.baseMs * p.factor ** (retryCount - 1));
  if (p.jitter) delay = Math.round(delay * (0.5 + 0.5 * pseudoJitter(retryCount)));
  return delay;
}

/** The next-retry timestamp (ms) for a message that has retried `retryCount` times. */
export function nextRetryAt(retryCount, policy, now = Date.now()) {
  return now + computeBackoff(retryCount, policy);
}

/** Whether another retransmission is permitted. */
export function shouldRetry(retryCount, policy) {
  return retryCount < resolveRetryPolicy(policy).maxRetries;
}

/** Deterministic pseudo-jitter in `[0,1)` (no Math.random → reproducible). */
function pseudoJitter(n) {
  const x = Math.sin((n + 1) * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * A **retransmission scheduler** — a thin timer driver over the engine's `sweepRetries`. In
 * production it runs on an interval; in tests it is driven manually via {@link tick}. The timer is
 * `unref`'d so it never keeps the process alive.
 */
export class RetransmissionScheduler {
  /**
   * @param {object} deps @param {import("../manager/messagingEngine.js").MessagingEngine} deps.engine
   * @param {number} [deps.intervalMs] @param {(e:unknown)=>void} [deps.onError]
   */
  constructor(deps) {
    if (!deps || !deps.engine) throw new Error("RetransmissionScheduler requires { engine }");
    this.engine = deps.engine;
    this.intervalMs = deps.intervalMs ?? 1_000;
    this.onError = deps.onError ?? ((e) => console.error("[data-plane] retransmission sweep failed:", e?.message ?? e));
    this._timer = null;
    this._running = false;
    this._stats = { sweeps: 0, retried: 0, failed: 0, lastSweepAt: null };
  }

  get isRunning() {
    return this._running;
  }
  stats() {
    return { ...this._stats, intervalMs: this.intervalMs, running: this._running };
  }

  /** Run one sweep now. @param {number} [now] */
  async tick(now) {
    try {
      const res = await this.engine.sweepRetries(now);
      this._stats.sweeps++;
      this._stats.retried += res.retried ?? 0;
      this._stats.failed += res.failed ?? 0;
      this._stats.lastSweepAt = new Date(now ?? this.engine.clock()).toISOString();
      return res;
    } catch (error) {
      this.onError(error);
      return { retried: 0, failed: 0 };
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._running = false;
  }
}

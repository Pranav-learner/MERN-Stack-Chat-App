/**
 * @module shs/retry
 *
 * Retry policy + backoff abstraction for the handshake framework. Pure and
 * deterministic (jitter is injectable), so it is easy to test and reason about.
 *
 * This layer decides WHEN a failed/timed-out handshake may be retried and HOW LONG
 * to wait before the next attempt. Actually performing the retry (creating a new
 * linked session) is the manager's job; this module holds no I/O.
 *
 * @example
 * ```js
 * const policy = new RetryPolicy({ maxRetries: 3, strategy: "exponential", baseMs: 500 });
 * policy.canRetry(0);   // true
 * policy.nextDelay(0);  // 500
 * policy.nextDelay(1);  // 1000
 * policy.nextDelay(2);  // 2000
 * policy.canRetry(3);   // false
 * ```
 */

import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
} from "../protocol/constants.js";

/** Backoff strategies. @readonly @enum {string} */
export const BackoffStrategy = Object.freeze({
  FIXED: "fixed",
  LINEAR: "linear",
  EXPONENTIAL: "exponential",
});

/**
 * A retry policy with a pluggable backoff curve.
 */
export class RetryPolicy {
  /**
   * @param {object} [options]
   * @param {number} [options.maxRetries=DEFAULT_MAX_RETRIES]
   * @param {string} [options.strategy="exponential"] one of {@link BackoffStrategy}
   * @param {number} [options.baseMs=DEFAULT_RETRY_BASE_MS] base delay
   * @param {number} [options.maxDelayMs=DEFAULT_RETRY_MAX_DELAY_MS] delay ceiling
   * @param {number} [options.jitterRatio=0] 0..1 fraction of jitter to apply
   * @param {() => number} [options.random] injectable [0,1) source (default: deterministic 0)
   */
  constructor(options = {}) {
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.strategy = options.strategy ?? BackoffStrategy.EXPONENTIAL;
    this.baseMs = options.baseMs ?? DEFAULT_RETRY_BASE_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.jitterRatio = Math.min(Math.max(options.jitterRatio ?? 0, 0), 1);
    // Deterministic by default so tests are stable; inject Math.random in prod.
    this.random = options.random ?? (() => 0);
  }

  /**
   * Whether a further attempt is allowed given the count already made.
   * @param {number} attemptsMade
   * @returns {boolean}
   */
  canRetry(attemptsMade) {
    return attemptsMade < this.maxRetries;
  }

  /** Remaining retries. */
  remaining(attemptsMade) {
    return Math.max(0, this.maxRetries - attemptsMade);
  }

  /**
   * The delay before the given (zero-based) attempt index, in ms. Attempt `0` is
   * the first retry after the initial try.
   * @param {number} attemptIndex
   * @returns {number} milliseconds (>= 0, capped at `maxDelayMs`)
   */
  nextDelay(attemptIndex) {
    const n = Math.max(0, attemptIndex);
    let delay;
    switch (this.strategy) {
      case BackoffStrategy.FIXED:
        delay = this.baseMs;
        break;
      case BackoffStrategy.LINEAR:
        delay = this.baseMs * (n + 1);
        break;
      case BackoffStrategy.EXPONENTIAL:
      default:
        delay = this.baseMs * 2 ** n;
        break;
    }
    delay = Math.min(delay, this.maxDelayMs);
    if (this.jitterRatio > 0) {
      // Subtract up to `jitterRatio` of the delay: result ∈ [delay*(1-r), delay].
      const reduction = delay * this.jitterRatio * this.random();
      delay = Math.min(Math.max(delay - reduction, 0), this.maxDelayMs);
    }
    return Math.round(delay);
  }

  /** A plain, serializable view of this policy. */
  describe() {
    return {
      maxRetries: this.maxRetries,
      strategy: this.strategy,
      baseMs: this.baseMs,
      maxDelayMs: this.maxDelayMs,
      jitterRatio: this.jitterRatio,
    };
  }
}

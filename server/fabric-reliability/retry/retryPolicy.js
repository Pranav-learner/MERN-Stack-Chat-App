/**
 * @module fabric-reliability/retry/retryPolicy
 *
 * **Retry + backoff policy** (STEP 5) — re-runs a transient-failing operation up to `maxAttempts` with a
 * configurable backoff (fixed / linear / exponential / exponential-with-jitter), consulting the
 * {@link FailureClassifier} so only retryable classes (transient / timeout / resource / unknown) are
 * retried — validation + authorization errors fail fast. The policy is pluggable + configurable (STEP 5
 * "operational resilience must be configurable and extensible"); the sleep + rng are injectable so tests
 * are deterministic + fast.
 *
 * @security Reasons over attempt counts + failure classes only. No content.
 */

import { FailureClassifier } from "./failureClassifier.js";
import { BackoffStrategy, RETRYABLE_CLASSES, DEFAULT_RETRY, ReliabilityEventType } from "../types/types.js";
import { RetryExhaustedError } from "../errors.js";

export class RetryPolicy {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxAttempts] @param {string} [opts.strategy] a {@link BackoffStrategy}
   * @param {number} [opts.baseDelayMs] @param {number} [opts.maxDelayMs] @param {number} [opts.jitterRatio]
   * @param {FailureClassifier} [opts.classifier] @param {import("../events/events.js").FabricReliabilityEventBus} [opts.events]
   * @param {(ms:number)=>Promise<void>} [opts.sleep] injectable sleep (default real) @param {()=>number} [opts.rng] injectable [0,1) rng
   */
  constructor(opts = {}) {
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_RETRY.maxAttempts;
    this.strategy = opts.strategy ?? DEFAULT_RETRY.strategy;
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
    this.maxDelayMs = opts.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;
    this.jitterRatio = opts.jitterRatio ?? DEFAULT_RETRY.jitterRatio;
    this.classifier = opts.classifier ?? new FailureClassifier();
    this.events = opts.events ?? null;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
    this.rng = opts.rng ?? Math.random;
  }

  /** The backoff delay (ms) before a given attempt number (1-indexed; attempt 1 has no prior delay). */
  computeDelay(attempt) {
    if (attempt <= 1) return 0; // the first attempt never waits
    const n = attempt - 2; // 2nd attempt → base delay, 3rd → base×2, …
    let delay;
    switch (this.strategy) {
      case BackoffStrategy.FIXED:
        delay = this.baseDelayMs;
        break;
      case BackoffStrategy.LINEAR:
        delay = this.baseDelayMs * (n + 1);
        break;
      case BackoffStrategy.EXPONENTIAL:
      case BackoffStrategy.EXPONENTIAL_JITTER:
        delay = this.baseDelayMs * 2 ** n;
        break;
      default:
        delay = this.baseDelayMs;
    }
    delay = Math.min(delay, this.maxDelayMs);
    if (this.strategy === BackoffStrategy.EXPONENTIAL_JITTER && this.jitterRatio > 0) {
      const jitter = delay * this.jitterRatio * (this.rng() * 2 - 1); // ±jitterRatio
      delay = Math.max(0, delay + jitter);
    }
    return Math.round(delay);
  }

  /** Whether an error is retryable at a given attempt. */
  shouldRetry(error, attempt) {
    if (attempt >= this.maxAttempts) return false;
    return RETRYABLE_CLASSES.includes(this.classifier.classify(error));
  }

  /**
   * Run `fn(attempt)` with retries. `fn` receives the 1-indexed attempt number. On a retryable failure it
   * waits the backoff delay and retries; on a non-retryable failure or exhaustion it rethrows (wrapping the
   * last error in a {@link RetryExhaustedError} when attempts ran out on a retryable class).
   * @param {(attempt:number)=>Promise<any>} fn @param {object} [ctx] `{ onRetry, operationId, kind }`
   * @returns {Promise<{ result:any, attempts:number }>}
   */
  async run(fn, ctx = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const result = await fn(attempt);
        return { result, attempts: attempt };
      } catch (error) {
        lastError = error;
        // a non-retryable class fails fast with the RAW error (preserves its classification)
        if (!RETRYABLE_CLASSES.includes(this.classifier.classify(error))) throw error;
        // retryable but out of attempts → RetryExhausted (retryable class), cause preserved
        if (attempt >= this.maxAttempts) break;
        const delay = this.computeDelay(attempt + 1);
        this.events?.emit(ReliabilityEventType.RETRY_SCHEDULED, { operationId: ctx.operationId, kind: ctx.kind, attempt, nextDelayMs: delay, failureClass: this.classifier.classify(error) });
        try {
          ctx.onRetry?.(attempt, error, delay);
        } catch {
          /* ignore hook errors */
        }
        if (delay > 0) await this.sleep(delay);
      }
    }
    throw new RetryExhaustedError(`Retry exhausted after ${this.maxAttempts} attempts`, { details: { attempts: this.maxAttempts, kind: ctx.kind }, cause: lastError });
  }
}

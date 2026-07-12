/**
 * @module group-reliability/retry
 *
 * **Configurable retry policies** for group-operation recovery. Supports immediate retry, exponential
 * backoff (with deterministic jitter), a fixed delay, a bounded max-attempt count, a lifetime retry
 * BUDGET, a cooldown, automatic resume, and per-call policy overrides. Pure functions + a small policy
 * resolver — no I/O.
 *
 * @distributed A retry budget (total retries across a record's life) bounds the cost of a persistently
 * failing operation so it can't retry-storm forever; the max-attempt count bounds a single recovery
 * episode. This is what stops a broken fan-out (e.g. a permanently offline member) from hammering the
 * platform.
 */

import { RetryStrategy, DEFAULT_RETRY_POLICY } from "../types/types.js";

/** Resolve a partial retry policy against the defaults. */
export function resolveRetryPolicy(policy) {
  return { ...DEFAULT_RETRY_POLICY, ...(policy ?? {}) };
}

/**
 * The backoff delay (ms) before a recovery attempt (1-based). @param {number} attempt @param {object} [policy]
 * @returns {number}
 */
export function computeBackoff(attempt, policy) {
  const p = resolveRetryPolicy(policy);
  if (attempt <= 0) return 0;
  switch (p.strategy) {
    case RetryStrategy.IMMEDIATE:
      return 0;
    case RetryStrategy.FIXED:
      return Math.min(p.maxDelayMs, p.baseDelayMs);
    case RetryStrategy.NONE:
      return Infinity; // never auto-retries
    case RetryStrategy.EXPONENTIAL_BACKOFF:
    default: {
      let delay = Math.min(p.maxDelayMs, p.baseDelayMs * p.factor ** (attempt - 1));
      if (p.jitter) delay = Math.round(delay * (0.5 + 0.5 * pseudoJitter(attempt)));
      return delay;
    }
  }
}

/** Whether another attempt is permitted for the CURRENT recovery episode. */
export function shouldRetry(attempt, policy) {
  const p = resolveRetryPolicy(policy);
  if (p.strategy === RetryStrategy.NONE) return false;
  return attempt < p.maxAttempts;
}

/** Whether the LIFETIME retry budget still has room. */
export function withinBudget(retryCount, policy) {
  const p = resolveRetryPolicy(policy);
  return (retryCount ?? 0) < p.retryBudget;
}

/** The next-retry timestamp (ms). */
export function nextRetryAt(attempt, policy, now = Date.now()) {
  const d = computeBackoff(attempt, policy);
  return Number.isFinite(d) ? now + d : null;
}

/** Deterministic pseudo-jitter in `[0,1)` (no Math.random → reproducible). */
function pseudoJitter(n) {
  const x = Math.sin((n + 1) * 51.1237) * 39211.2531;
  return x - Math.floor(x);
}

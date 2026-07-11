/**
 * @module network-reliability/retry
 *
 * **Configurable retry & reconnection policies.** A pure policy engine that decides *whether* and
 * *when* to retry a reconnection: immediate, fixed delay, or exponential backoff, bounded by a max
 * attempt count, a cooldown, and an overall recovery timeout. Policies are data (see
 * {@link module:network-reliability/types.DEFAULT_RETRY_POLICY}) so a caller can override per
 * connection or per trigger.
 *
 * @networking Retrying too fast is a self-DoS; too slow feels broken. Exponential backoff with
 * jitter spreads a fleet's reconnect storm; a recovery timeout guarantees a bounded "give up".
 */

import { RetryStrategy, DEFAULT_RETRY_POLICY } from "../types/types.js";

/** Resolve a partial policy against the defaults. @returns {object} */
export function resolveRetryPolicy(policy) {
  if (!policy) return { ...DEFAULT_RETRY_POLICY };
  return { ...DEFAULT_RETRY_POLICY, ...policy };
}

/**
 * The delay (ms) before the given attempt (1-based) under a policy. Attempt 1 has no prior delay for
 * IMMEDIATE; backoff grows from `baseDelayMs`.
 * @param {number} attempt 1-based @param {object} [policy] @returns {number} delay ms
 */
export function nextDelay(attempt, policy) {
  const p = resolveRetryPolicy(policy);
  let delay;
  switch (p.strategy) {
    case RetryStrategy.IMMEDIATE:
      delay = 0;
      break;
    case RetryStrategy.NONE:
      delay = 0;
      break;
    case RetryStrategy.FIXED:
      delay = p.baseDelayMs;
      break;
    case RetryStrategy.EXPONENTIAL_BACKOFF:
    default:
      delay = Math.min(p.maxDelayMs, p.baseDelayMs * p.factor ** Math.max(0, attempt - 1));
      break;
  }
  if (p.jitter && delay > 0) {
    // Deterministic pseudo-jitter (no Math.random → reproducible): 50–100% of the delay.
    const j = pseudoJitter(attempt);
    delay = Math.round(delay * (0.5 + 0.5 * j));
  }
  return delay;
}

/**
 * Whether another retry is permitted.
 * @param {number} attempt the NEXT attempt number (1-based) @param {number} elapsedMs total time spent recovering
 * @param {object} [policy] @returns {{ allowed: boolean, reason?: string }}
 */
export function shouldRetry(attempt, elapsedMs, policy) {
  const p = resolveRetryPolicy(policy);
  if (p.strategy === RetryStrategy.NONE) return { allowed: false, reason: "manual-only" };
  if (attempt > p.maxAttempts) return { allowed: false, reason: "max-attempts" };
  if (Number.isFinite(elapsedMs) && elapsedMs >= p.recoveryTimeoutMs) return { allowed: false, reason: "recovery-timeout" };
  return { allowed: true };
}

/** Deterministic pseudo-jitter in `[0,1)` from an integer (no Math.random). */
function pseudoJitter(n) {
  const x = Math.sin((n + 1) * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * A small stateful driver over a policy: track attempts + elapsed time, ask for the next delay, and
 * whether to keep going. The manager uses this to drive a bounded reconnect loop with an INJECTED
 * sleep (real timer in production, no-op in tests).
 */
export class RetryController {
  /** @param {object} [policy] @param {{ clock?: () => number, sleep?: (ms:number)=>Promise<void> }} [deps] */
  constructor(policy, deps = {}) {
    this.policy = resolveRetryPolicy(policy);
    this.clock = deps.clock ?? (() => Date.now());
    this._sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.attempt = 0;
    this.startedAt = this.clock();
  }

  /** Elapsed recovery time (ms). */
  get elapsedMs() {
    return this.clock() - this.startedAt;
  }

  /**
   * Advance to the next attempt: check the budget, wait the backoff, and return whether to proceed.
   * @returns {Promise<{ proceed: boolean, attempt: number, reason?: string }>}
   */
  async next() {
    const attempt = this.attempt + 1;
    const decision = shouldRetry(attempt, this.elapsedMs, this.policy);
    if (!decision.allowed) return { proceed: false, attempt, reason: decision.reason };
    const delay = this.attempt === 0 ? 0 : nextDelay(attempt, this.policy) + this.policy.cooldownMs;
    if (delay > 0) await this._sleep(delay);
    this.attempt = attempt;
    return { proceed: true, attempt };
  }

  /** Reset the controller (e.g. after a successful reconnect). */
  reset() {
    this.attempt = 0;
    this.startedAt = this.clock();
  }
}

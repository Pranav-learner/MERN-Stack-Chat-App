/**
 * @module networking-hardening/ratelimit
 *
 * **Rate limiting + abuse prevention** for the networking APIs. A dependency-free token-bucket
 * limiter keyed by an arbitrary subject (user id, ip, `user:action`). It is the extension point the
 * controllers call before an expensive operation (discovery, negotiation, plan generation) to blunt
 * enumeration + abuse. Plus enumeration-resistance helpers that keep "unknown user" and "not
 * authorized" indistinguishable.
 *
 * @security Rate limiting is an abuse-prevention control, not authentication. Enumeration resistance
 * ensures a probe can't tell a real-but-hidden peer from a nonexistent one. Neither handles key
 * material.
 *
 * @distributed The token bucket is process-local here; the SAME interface (`consume`/`check`) maps
 * onto a shared store (Redis `INCR`+`EXPIRE`, or a sliding-window script) for a load-balanced fleet.
 *
 * @example
 * ```js
 * const limiter = new RateLimiter({ capacity: 60, refillPerSec: 30 });
 * limiter.consume(`discover:${userId}`); // throws RateLimitedError when exhausted
 * ```
 */

import { DEFAULT_RATE_LIMIT, HardeningEventType, Metric } from "../types/types.js";
import { RateLimitedError } from "../errors.js";
import { HardeningEventBus } from "../events/events.js";

export class RateLimiter {
  /**
   * @param {object} [options]
   * @param {number} [options.capacity] bucket size (burst) @param {number} [options.refillPerSec] tokens/sec
   * @param {() => number} [options.clock] @param {HardeningEventBus} [options.events]
   * @param {import("../observability/metrics.js").NetworkingMetrics} [options.metrics]
   */
  constructor(options = {}) {
    this.capacity = options.capacity ?? DEFAULT_RATE_LIMIT.capacity;
    this.refillPerSec = options.refillPerSec ?? DEFAULT_RATE_LIMIT.refillPerSec;
    this.clock = options.clock ?? (() => Date.now());
    this.events = options.events ?? null;
    this.metrics = options.metrics ?? null;
    /** @type {Map<string, { tokens: number, updatedAt: number }>} */
    this._buckets = new Map();
  }

  /**
   * Check a subject WITHOUT consuming a token.
   * @param {string} subject @param {number} [cost=1]
   * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
   */
  check(subject, cost = 1) {
    const bucket = this._refill(subject);
    if (bucket.tokens >= cost) return { allowed: true, remaining: Math.floor(bucket.tokens - cost), retryAfterMs: 0 };
    const deficit = cost - bucket.tokens;
    return { allowed: false, remaining: Math.floor(bucket.tokens), retryAfterMs: Math.ceil((deficit / this.refillPerSec) * 1000) };
  }

  /**
   * Consume `cost` tokens for a subject. @throws {RateLimitedError} when the bucket is empty.
   * @param {string} subject @param {number} [cost=1] @returns {{ remaining: number }}
   */
  consume(subject, cost = 1) {
    const bucket = this._refill(subject);
    if (bucket.tokens < cost) {
      const { retryAfterMs } = this.check(subject, cost);
      this.metrics?.increment(Metric.RATE_LIMITED_TOTAL, 1, { subject: labelize(subject) });
      this.events?.emit(HardeningEventType.RATE_LIMITED, { subject, retryAfterMs });
      throw new RateLimitedError("Rate limit exceeded", { retryAfterMs, details: { subject } });
    }
    bucket.tokens -= cost;
    return { remaining: Math.floor(bucket.tokens) };
  }

  /** Reset a subject's bucket (or all if omitted). */
  reset(subject) {
    if (subject === undefined) this._buckets.clear();
    else this._buckets.delete(subject);
  }

  /** Number of tracked subjects. */
  get size() {
    return this._buckets.size;
  }

  /** @private Lazily refill a subject's bucket based on elapsed time. */
  _refill(subject) {
    const now = this.clock();
    let bucket = this._buckets.get(subject);
    if (!bucket) {
      bucket = { tokens: this.capacity, updatedAt: now };
      this._buckets.set(subject, bucket);
      return bucket;
    }
    const elapsedSec = Math.max(0, (now - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
    bucket.updatedAt = now;
    return bucket;
  }
}

/** Keep rate-limit metric labels low-cardinality (bucket subjects by their action prefix). */
function labelize(subject) {
  const s = String(subject);
  const i = s.indexOf(":");
  return i === -1 ? s : s.slice(0, i);
}

/**
 * Enumeration-resistance: a uniform "not found" that is indistinguishable from "not authorized" and
 * "hidden". Controllers use this so a probe cannot enumerate which users/devices exist by diffing
 * status codes or messages.
 * @returns {{ status: number, body: { success: false, code: string, message: string } }}
 */
export function uniformNotFound() {
  return { status: 404, body: { success: false, code: "ERR_NOT_FOUND", message: "Not found" } };
}

/**
 * Whether two logically-distinct outcomes have been made indistinguishable (for tests + audits):
 * an unknown subject and an unauthorized-but-existing subject should map to the same response.
 * @param {object} a @param {object} b @returns {boolean}
 */
export function areResponsesUniform(a, b) {
  return a?.status === b?.status && a?.body?.code === b?.body?.code && a?.body?.message === b?.body?.message;
}

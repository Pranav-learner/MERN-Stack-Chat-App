/**
 * @module shs/hardening/replay/timestampValidator
 *
 * Timestamp freshness validation. A message whose timestamp is too far in the past
 * (older than the acceptance window) or too far in the future (beyond the allowed
 * clock skew) is rejected — this bounds how long a captured message stays useful to a
 * replayer and pairs with the {@link ReplayCache}.
 *
 * Pure functions; the clock is injectable for testing.
 */

import { ReplayReason } from "../types.js";

/** Default acceptance window for a message's age (ms). */
export const DEFAULT_MAX_AGE_MS = 120_000; // 2 minutes
/** Default tolerated forward clock skew (ms). */
export const DEFAULT_MAX_SKEW_MS = 30_000; // 30 seconds

/**
 * @typedef {object} TimestampVerdict
 * @property {boolean} ok
 * @property {string} [reason] {@link ReplayReason.STALE_TIMESTAMP} | {@link ReplayReason.FUTURE_TIMESTAMP}
 * @property {number} [ageMs]
 */

/**
 * Validate a message timestamp against now.
 * @param {number} timestamp epoch ms from the message
 * @param {{ now?: number, maxAgeMs?: number, maxSkewMs?: number }} [options]
 * @returns {TimestampVerdict}
 */
export function checkTimestamp(timestamp, options = {}) {
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxSkew = options.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;

  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return { ok: false, reason: ReplayReason.STALE_TIMESTAMP };
  }
  const age = now - timestamp;
  if (age > maxAge) return { ok: false, reason: ReplayReason.STALE_TIMESTAMP, ageMs: age };
  if (age < -maxSkew) return { ok: false, reason: ReplayReason.FUTURE_TIMESTAMP, ageMs: age };
  return { ok: true, ageMs: age };
}

/** Whether a timestamp is fresh (non-throwing convenience). */
export function isFresh(timestamp, options = {}) {
  return checkTimestamp(timestamp, options).ok;
}

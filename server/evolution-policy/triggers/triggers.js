/**
 * @module evolution-policy/triggers
 *
 * **Triggers** — the signals that feed policy evaluation. A trigger does not itself cause
 * a rekey; it updates the evaluation context, which the {@link module:evolution-policy/evaluator}
 * then reads. This module provides:
 *
 * - a per-session **message counter** (drives message-count policies);
 * - a helper to build a deterministic **evaluation context** from raw signals.
 *
 * @security No cryptography; pure bookkeeping. Counters are device/process-local metadata.
 */

import { TriggerType } from "../types/types.js";

/**
 * Tracks messages sent since the last rekey, per session (drives message-count policies).
 * Reset on a successful rekey so the next threshold measures fresh traffic.
 */
export class MessageCounter {
  constructor() {
    /** @type {Map<string, number>} */
    this._counts = new Map();
  }

  /** Increment a session's counter by `n` (default 1) and return the new value. */
  increment(sessionId, n = 1) {
    const key = String(sessionId);
    const next = (this._counts.get(key) ?? 0) + n;
    this._counts.set(key, next);
    return next;
  }

  /** The current count for a session. */
  get(sessionId) {
    return this._counts.get(String(sessionId)) ?? 0;
  }

  /** Reset a session's counter to 0 (call after a successful rekey). */
  reset(sessionId) {
    this._counts.set(String(sessionId), 0);
  }

  /** Drop a session's counter entirely (teardown). */
  delete(sessionId) {
    this._counts.delete(String(sessionId));
  }

  /** Number of tracked sessions. */
  get size() {
    return this._counts.size;
  }
}

/**
 * Build a deterministic evaluation context from raw trigger signals + timing. Everything a
 * policy might read is computed here so evaluation stays a pure function.
 *
 * @param {object} params
 * @param {number} params.now epoch ms (from the engine clock)
 * @param {number} [params.messagesSinceLastEvolution]
 * @param {string} [params.sessionCreatedAt] ISO — to compute `sessionAgeMs`
 * @param {boolean} [params.manual] @param {string} [params.securityEvent] @param {string} [params.deviceEvent]
 * @param {boolean} [params.administrator] @param {string} [params.trigger] a {@link TriggerType}
 * @returns {object} the evaluation context
 */
export function buildEvaluationContext(params) {
  const now = params.now ?? Date.now();
  return {
    now,
    messagesSinceLastEvolution: params.messagesSinceLastEvolution ?? 0,
    sessionAgeMs: params.sessionCreatedAt ? Math.max(0, now - new Date(params.sessionCreatedAt).getTime()) : 0,
    manual: params.manual === true,
    securityEvent: params.securityEvent,
    deviceEvent: params.deviceEvent,
    administrator: params.administrator === true,
    trigger: params.trigger,
  };
}

export { TriggerType };

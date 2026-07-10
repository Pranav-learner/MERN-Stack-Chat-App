/**
 * @module evolution-policy/scheduler
 *
 * **Scheduling infrastructure** for autonomous, time-driven rekeying. The scheduler tracks
 * the next due time per session (recurring for time-based policies, one-off for
 * session-age / deferred rekeys) and reports which sessions are due on a `tick`. It does
 * NOT evaluate policies or perform rekeys — the {@link module:evolution-policy/manager}
 * consumes `due(now)` and drives the evaluation.
 *
 * @security Pure bookkeeping over timestamps; no cryptography, no key material. Deterministic
 * given an injected clock.
 */

import { InvalidScheduleError } from "../errors.js";

export class RekeyScheduler {
  /** @param {{ clock?: () => number }} [options] */
  constructor(options = {}) {
    this._clock = options.clock ?? (() => Date.now());
    /** @type {Map<string, { sessionId: string, dueAt: number, recurring: boolean, intervalMs: number|null }>} */
    this._entries = new Map();
  }

  /**
   * Register (or replace) a session's schedule.
   * @param {string} sessionId
   * @param {{ dueAt?: number, dueInMs?: number, recurring?: boolean, intervalMs?: number }} spec
   * @returns {object} the stored entry
   * @throws {InvalidScheduleError}
   */
  register(sessionId, spec = {}) {
    const now = this._clock();
    const dueAt = spec.dueAt ?? (spec.dueInMs != null ? now + spec.dueInMs : spec.intervalMs != null ? now + spec.intervalMs : null);
    if (dueAt == null || !Number.isFinite(dueAt)) {
      throw new InvalidScheduleError("A schedule requires a positive dueAt / dueInMs / intervalMs", { details: { spec } });
    }
    if (spec.recurring && (!Number.isFinite(spec.intervalMs) || spec.intervalMs <= 0)) {
      throw new InvalidScheduleError("A recurring schedule requires a positive intervalMs", { details: { intervalMs: spec.intervalMs } });
    }
    const entry = { sessionId: String(sessionId), dueAt, recurring: Boolean(spec.recurring), intervalMs: spec.intervalMs ?? null };
    this._entries.set(entry.sessionId, entry);
    return { ...entry };
  }

  /** Schedule a one-off rekey at a future time. */
  scheduleOnce(sessionId, { dueAt, dueInMs } = {}) {
    return this.register(sessionId, { dueAt, dueInMs, recurring: false });
  }

  /** The sessions whose schedule is due (`dueAt <= now`). */
  due(now = this._clock()) {
    return [...this._entries.values()].filter((e) => e.dueAt <= now).map((e) => e.sessionId);
  }

  /**
   * Advance a fired session's schedule: recurring → reschedule `intervalMs` out; one-off →
   * remove. @returns {object|null} the new entry, or null if removed.
   */
  mark(sessionId, now = this._clock()) {
    const key = String(sessionId);
    const entry = this._entries.get(key);
    if (!entry) return null;
    if (entry.recurring && entry.intervalMs) {
      entry.dueAt = now + entry.intervalMs;
      return { ...entry };
    }
    this._entries.delete(key);
    return null;
  }

  /** The stored entry for a session, or null. */
  get(sessionId) {
    const e = this._entries.get(String(sessionId));
    return e ? { ...e } : null;
  }

  /** Whether a session has a schedule. */
  has(sessionId) {
    return this._entries.has(String(sessionId));
  }

  /** Cancel a session's schedule. @returns {boolean} */
  cancel(sessionId) {
    return this._entries.delete(String(sessionId));
  }

  /** Number of scheduled sessions. */
  get size() {
    return this._entries.size;
  }

  /** Remove all schedules. */
  clear() {
    this._entries.clear();
  }
}

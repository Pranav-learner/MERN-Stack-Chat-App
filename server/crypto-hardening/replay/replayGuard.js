/**
 * @module crypto-hardening/replay
 *
 * **Replay protection engine** — transport-level, defence-in-depth replay resistance layered
 * on top of the per-message-key layer's intrinsic replay rejection (Sprint 5). Before a
 * ciphertext is decrypted, the guard validates:
 *
 * 1. **Generation** — refuse a message from a generation older than the session's accepted
 *    floor (generation-rollback / downgrade protection).
 * 2. **Duplicate message** — refuse a `(generation, messageNumber)` already seen.
 * 3. **Duplicate nonce** — refuse a per-message nonce already seen (duplicate-ciphertext).
 * 4. **Window** — refuse a message far below the high-water mark (outside the sliding window),
 *    which cannot be tracked precisely and is almost certainly a replay.
 *
 * Accepted messages are recorded in a bounded, TTL-expiring per-session cache. On reconnect,
 * {@link ReplayGuard#restore} re-seeds the high-water mark from persisted metadata so the guard
 * does not re-accept already-delivered messages; {@link ReplayGuard#reset} clears a session.
 *
 * @security The guard sees METADATA only (session id, generation, message number, nonce). It
 * emits replay-audit events for the {@link module:crypto-hardening/monitoring SecurityMonitor}.
 */

import {
  ReplayVerdict,
  HardeningEventType,
  DEFAULT_REPLAY_WINDOW,
  DEFAULT_REPLAY_TTL_MS,
  DEFAULT_NONCE_CACHE,
} from "../types/types.js";
import { HardeningEventBus } from "../events/events.js";
import { ReplayRejectedError, HardeningValidationError } from "../errors.js";

export class ReplayGuard {
  /**
   * @param {object} [deps]
   * @param {HardeningEventBus} [deps.events] @param {import("../observability/metrics.js").MetricsRegistry} [deps.metrics]
   * @param {() => number} [deps.clock] @param {number} [deps.windowSize] @param {number} [deps.ttlMs] @param {number} [deps.nonceCache]
   */
  constructor(deps = {}) {
    this.events = deps.events ?? new HardeningEventBus();
    this.metrics = deps.metrics ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    this.windowSize = deps.windowSize ?? DEFAULT_REPLAY_WINDOW;
    this.ttlMs = deps.ttlMs ?? DEFAULT_REPLAY_TTL_MS;
    this.nonceCacheSize = deps.nonceCache ?? DEFAULT_NONCE_CACHE;
    /** @type {Map<string, { generationFloor: number, highWater: number, seen: Map<string, number>, nonces: Map<string, number> }>} */
    this._sessions = new Map();
  }

  /**
   * Validate a message against replay rules WITHOUT recording it. Pure-ish (reads state).
   * @param {import("../types/types.js").ReplayContext} ctx
   * @returns {{ ok: boolean, verdict: string, reason?: string }}
   */
  inspect(ctx) {
    const v = this._validate(ctx);
    return { ok: v.verdict === ReplayVerdict.OK, verdict: v.verdict, reason: v.verdict === ReplayVerdict.OK ? undefined : v.verdict };
  }

  /**
   * Validate AND record a message. On success the message is remembered (so a later replay is
   * caught). On failure a replay-detected event is emitted.
   * @param {import("../types/types.js").ReplayContext} ctx
   * @returns {{ ok: boolean, verdict: string }}
   */
  accept(ctx) {
    const v = this._validate(ctx);
    if (v.verdict !== ReplayVerdict.OK) {
      this.metrics?.increment("replay_rejected_total", 1, { verdict: v.verdict });
      this.events.emit(HardeningEventType.REPLAY_DETECTED, { sessionId: ctx.sessionId, generation: ctx.generation, messageNumber: ctx.messageNumber, reason: v.verdict });
      return { ok: false, verdict: v.verdict };
    }
    this._record(ctx, v.state);
    this.metrics?.increment("replay_accepted_total");
    this.events.emit(HardeningEventType.REPLAY_ACCEPTED, { sessionId: ctx.sessionId, generation: ctx.generation, messageNumber: ctx.messageNumber });
    return { ok: true, verdict: ReplayVerdict.OK };
  }

  /**
   * Like {@link accept} but throws {@link ReplayRejectedError} on rejection (for pipelines that
   * prefer exceptions). @param {import("../types/types.js").ReplayContext} ctx
   */
  assertFresh(ctx) {
    const r = this.accept(ctx);
    if (!r.ok) throw new ReplayRejectedError(`Replay rejected: ${r.verdict}`, { details: { ...ctx, verdict: r.verdict } });
    return r;
  }

  /**
   * Reconnect recovery: re-seed the accepted floor + high-water mark from persisted delivery
   * metadata so already-delivered messages are not re-accepted after a reconnect.
   * @param {string} sessionId @param {{ generation: number, highWater: number }} state
   */
  restore(sessionId, state) {
    const s = this._session(sessionId);
    s.generationFloor = Math.max(s.generationFloor, state.generation ?? 0);
    s.highWater = Math.max(s.highWater, state.highWater ?? -1);
    return { generationFloor: s.generationFloor, highWater: s.highWater };
  }

  /** Reset a session's replay window (e.g. on a clean re-establish). Emits a reset event. */
  reset(sessionId) {
    this._sessions.delete(String(sessionId));
    this.events.emit(HardeningEventType.REPLAY_WINDOW_RESET, { sessionId: String(sessionId) });
  }

  /** Note a session advanced to a new generation: raise the floor (rollback protection). */
  advanceGeneration(sessionId, generation) {
    const s = this._session(sessionId);
    if (generation > s.generationFloor) {
      s.generationFloor = generation;
      s.highWater = -1; // message numbers restart per generation
      s.seen.clear();
    }
    return s.generationFloor;
  }

  /** Expire TTL-aged entries across all sessions. @returns {{ expired: number }} */
  expire(now = this.clock()) {
    let expired = 0;
    for (const s of this._sessions.values()) {
      for (const [k, t] of s.seen) if (now - t >= this.ttlMs) (s.seen.delete(k), expired++);
      for (const [k, t] of s.nonces) if (now - t >= this.ttlMs) s.nonces.delete(k);
    }
    return { expired };
  }

  /** Compact status for a session. */
  status(sessionId) {
    const s = this._sessions.get(String(sessionId));
    return s ? { generationFloor: s.generationFloor, highWater: s.highWater, tracked: s.seen.size, nonces: s.nonces.size } : null;
  }

  /** Number of tracked sessions. */
  get size() {
    return this._sessions.size;
  }

  // === internals ==========================================================

  /** @private */
  _session(sessionId) {
    const key = String(sessionId);
    let s = this._sessions.get(key);
    if (!s) {
      s = { generationFloor: 0, highWater: -1, seen: new Map(), nonces: new Map() };
      this._sessions.set(key, s);
    }
    return s;
  }

  /** @private Validate replay rules; returns `{ verdict, state }`. */
  _validate(ctx) {
    if (!ctx || typeof ctx.sessionId !== "string" || !Number.isInteger(ctx.generation) || !Number.isInteger(ctx.messageNumber) || ctx.messageNumber < 0) {
      throw new HardeningValidationError("Malformed replay context", { details: { ctx } });
    }
    const s = this._session(ctx.sessionId);
    if (ctx.generation < s.generationFloor) return { verdict: ReplayVerdict.GENERATION_ROLLBACK, state: s };
    // Only enforce ordering/window within the current accepted generation.
    if (ctx.generation === s.generationFloor) {
      const msgKey = `${ctx.generation}:${ctx.messageNumber}`;
      if (s.seen.has(msgKey)) return { verdict: ReplayVerdict.DUPLICATE_MESSAGE, state: s };
      if (ctx.messageNumber < s.highWater - this.windowSize) return { verdict: ReplayVerdict.OUT_OF_WINDOW, state: s };
    }
    if (ctx.nonce) {
      if (s.nonces.has(ctx.nonce)) return { verdict: ReplayVerdict.DUPLICATE_NONCE, state: s };
    }
    return { verdict: ReplayVerdict.OK, state: s };
  }

  /** @private Record an accepted message + bound the caches. */
  _record(ctx, s) {
    // a higher generation advances the floor
    if (ctx.generation > s.generationFloor) {
      s.generationFloor = ctx.generation;
      s.highWater = -1;
      s.seen.clear();
    }
    const now = this.clock();
    s.seen.set(`${ctx.generation}:${ctx.messageNumber}`, now);
    s.highWater = Math.max(s.highWater, ctx.messageNumber);
    if (ctx.nonce) s.nonces.set(ctx.nonce, now);
    // bound the caches (drop oldest)
    trimOldest(s.seen, this.windowSize);
    trimOldest(s.nonces, this.nonceCacheSize);
  }
}

/** Drop the oldest entries from an insertion-ordered Map until it fits `max`. */
function trimOldest(map, max) {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

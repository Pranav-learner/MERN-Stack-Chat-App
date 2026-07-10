/**
 * @module shs/hardening/replay/replayProtector
 *
 * The Replay Protector — the facade that combines timestamp freshness with the
 * {@link ReplayCache} (nonce + message-id + handshake-id tracking) and emits replay
 * events. It is the single entry point the handshake path calls to reject replays.
 *
 * ## Strategy
 * 1. **Timestamp validation** bounds a message's useful lifetime (stale/future).
 * 2. **Nonce + message-id tracking** rejects an exact re-send within the window.
 * 3. **Handshake-id first-use** optionally binds a nonce to a handshake so the same
 *    nonce cannot be reused across handshakes.
 * The cache TTL is aligned to the timestamp window so a message that is too old to be
 * accepted is also safe to forget — bounding memory.
 *
 * @example
 * ```js
 * const rp = new ReplayProtector({ events });
 * const verdict = rp.check(message);          // { ok, reason? }
 * if (!verdict.ok) throw new ReplayDetectedError(verdict.reason);
 * rp.remember(message);                        // record it as seen
 * // or, atomically:
 * rp.accept(message);                          // check + remember, throws on replay
 * ```
 */

import { ReplayCache } from "./replayCache.js";
import { checkTimestamp, DEFAULT_MAX_AGE_MS } from "./timestampValidator.js";
import { ReplayReason, HardeningEventType } from "../types.js";
import { ReplayDetectedError } from "../errors.js";

export class ReplayProtector {
  /**
   * @param {object} [deps]
   * @param {ReplayCache} [deps.cache]
   * @param {{ emit: Function }} [deps.events] a hardening event bus
   * @param {() => number} [deps.clock]
   * @param {number} [deps.maxAgeMs] timestamp acceptance window (also the cache TTL)
   * @param {number} [deps.maxSkewMs] tolerated forward clock skew
   */
  constructor(deps = {}) {
    this.clock = deps.clock ?? (() => Date.now());
    this.maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.maxSkewMs = deps.maxSkewMs;
    this.events = deps.events ?? null;
    this.cache =
      deps.cache ??
      new ReplayCache({
        ttlMs: this.maxAgeMs,
        clock: this.clock,
        onEvict: (key, reason) =>
          reason === "capacity" && this._emit(HardeningEventType.REPLAY_CACHE_EVICTED, { key }),
      });
  }

  /**
   * Check a message for replay WITHOUT recording it. Returns a verdict.
   * @param {{ nonce?: string, messageId?: string, handshakeId?: string, timestamp?: number }} message
   * @returns {import("../types.js").ReplayVerdict}
   */
  check(message) {
    const ts = checkTimestamp(message.timestamp, { now: this.clock(), maxAgeMs: this.maxAgeMs, maxSkewMs: this.maxSkewMs });
    if (!ts.ok) return this._reject(ts.reason, message, { ageMs: ts.ageMs });

    if (message.messageId && this.cache.has(this._mid(message.messageId))) {
      return this._reject(ReplayReason.DUPLICATE_MESSAGE_ID, message, { messageId: message.messageId });
    }
    if (message.nonce && this.cache.has(this._nonce(message.nonce))) {
      return this._reject(ReplayReason.DUPLICATE_NONCE, message, { nonce: message.nonce });
    }
    return { ok: true };
  }

  /**
   * Record a message's identifiers as seen (idempotent). Call after a successful
   * {@link check}. @param {object} message
   */
  remember(message) {
    if (message.messageId) this.cache.add(this._mid(message.messageId));
    if (message.nonce) this.cache.add(this._nonce(message.nonce));
  }

  /**
   * Atomically check + remember; throws {@link ReplayDetectedError} on a replay.
   * @param {object} message @returns {import("../types.js").ReplayVerdict}
   */
  accept(message) {
    const verdict = this.check(message);
    if (!verdict.ok) {
      throw new ReplayDetectedError(`Replay rejected: ${verdict.reason}`, { details: { reason: verdict.reason, ...verdict.details } });
    }
    this.remember(message);
    return verdict;
  }

  /**
   * Mark a handshake id as consumed (first-use). Returns false (and does not throw) if
   * the handshake id has been seen — callers decide whether that is fatal.
   * @param {string} handshakeId
   */
  consumeHandshakeId(handshakeId) {
    const key = `hs:${handshakeId}`;
    const fresh = this.cache.add(key);
    if (!fresh) this._emit(HardeningEventType.REPLAY_DETECTED, { reason: ReplayReason.DUPLICATE_HANDSHAKE, handshakeId });
    return fresh;
  }

  /** Eagerly prune expired entries (housekeeping hook). */
  prune() {
    return this.cache.prune();
  }

  // === internals ==========================================================

  _mid(id) {
    return `mid:${id}`;
  }
  _nonce(n) {
    return `nonce:${n}`;
  }

  _reject(reason, message, details = {}) {
    this._emit(HardeningEventType.REPLAY_DETECTED, { reason, handshakeId: message.handshakeId, details });
    return { ok: false, reason, details };
  }

  _emit(type, payload) {
    if (this.events) this.events.emit(type, payload);
  }
}

/**
 * @module session-integration/repositories/sessionContextRepository
 *
 * Repository extensions for session-aware messaging. It resolves the **active session
 * for a participant pair** (the Sprint 3 session repo is keyed by handshake/sessionId,
 * not by pair), adds a short-TTL **cache** for hot lookups, exposes **invalidation**,
 * and tracks **statistics** (hits/misses, resolutions).
 *
 * It composes the Sprint 3 {@link SecureSessionManager} — it does not replace or
 * modify it. Persistence details stay inside the wrapped manager/repo.
 *
 * @security Returns session DTOs (PUBLIC metadata + key metadata) only — never keys.
 */

import { pairKey } from "../validators/sessionValidators.js";

/** Session statuses that make a session usable for messaging. */
const USABLE = new Set(["active", "idle", "resumed"]);

/** A tiny TTL cache with hit/miss stats. */
class TtlCache {
  constructor(ttlMs, clock) {
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) {
      this.misses++;
      return undefined;
    }
    if (this.ttlMs > 0 && this.clock() >= e.exp) {
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return e.value;
  }
  set(key, value) {
    this.map.set(key, { value, exp: this.clock() + this.ttlMs });
  }
  delete(key) {
    return this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
  get size() {
    return this.map.size;
  }
}

export class SessionContextRepository {
  /**
   * @param {object} deps
   * @param {object} deps.sessions a SecureSessionManager (Sprint 3)
   * @param {() => number} [deps.clock] @param {number} [deps.cacheTtlMs=3000]
   */
  constructor(deps) {
    if (!deps || !deps.sessions) throw new Error("SessionContextRepository requires { sessions }");
    this.sessions = deps.sessions;
    this.clock = deps.clock ?? (() => Date.now());
    this.cache = new TtlCache(deps.cacheTtlMs ?? 3000, this.clock);
    this._stats = { lookups: 0, resolved: 0, missing: 0, invalidations: 0 };
  }

  /**
   * The active session bound to a participant pair, or null. Cached by pair key.
   * @param {string} a @param {string} b @returns {Promise<object|null>} a session DTO
   */
  async findActiveByPair(a, b) {
    this._stats.lookups++;
    const key = pairKey(a, b);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    // Sprint 3 repo is keyed by handshake/user; resolve the pair by scanning the
    // caller's sessions (indexed on participants) for the counterparty + usable state.
    const mine = await this.sessions.listSessions(a);
    const match =
      mine.find(
        (s) => USABLE.has(s.status) && !s.isExpired && (s.participants ?? []).map(String).includes(String(b)),
      ) ?? null;

    this.cache.set(key, match);
    if (match) this._stats.resolved++;
    else this._stats.missing++;
    return match;
  }

  /** Load a single session by id (delegates; no pair cache). */
  async lookupSession(sessionId) {
    return this.sessions.getSession(sessionId);
  }

  /** Cache a resolved session for a pair (used after create/resume). */
  cacheForPair(a, b, session) {
    this.cache.set(pairKey(a, b), session ?? null);
  }

  /** Invalidate the cached session for a pair (e.g. on close/expire/rekey). */
  invalidatePair(a, b) {
    this._stats.invalidations++;
    return this.cache.delete(pairKey(a, b));
  }

  /** Invalidate the entire cache. */
  invalidateAll() {
    this._stats.invalidations++;
    this.cache.clear();
  }

  /** Repository + cache statistics. */
  stats() {
    return {
      ...this._stats,
      cacheSize: this.cache.size,
      cacheHits: this.cache.hits,
      cacheMisses: this.cache.misses,
      hitRate: this.cache.hits + this.cache.misses > 0 ? this.cache.hits / (this.cache.hits + this.cache.misses) : 0,
    };
  }
}

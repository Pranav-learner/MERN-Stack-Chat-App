/**
 * @module presence/cache
 *
 * The **Presence Cache** — an in-memory, TTL-bounded, LRU-capped cache of *resolved presence
 * views*, keyed by user. Presence changes fast, so the TTL is deliberately SHORT and the cache
 * is aggressively invalidated on any presence change for a user; it exists mainly to absorb
 * read storms (many peers asking "who of user U is online?" at once) without hammering the
 * repository.
 *
 * It supports:
 * - **positive caching** — a resolved list of a user's reachable device advertisements;
 * - **negative caching** — a remembered "no reachable devices" with a shorter TTL;
 * - **TTL expiry** — entries past their TTL are treated as misses and pruned;
 * - **automatic invalidation** — targeted (by user) clearing on any presence write;
 * - **capacity limits** — LRU eviction beyond a configured size.
 *
 * @security Cached values are PUBLIC presence views only — no secret key material. The cache is
 * process-local.
 *
 * @evolution A future distributed deployment swaps this for Redis behind the SAME interface
 * (`get` / `set` / `setNegative` / `invalidateUser` / `pruneExpired`). Keeping the surface
 * minimal is what makes that swap a drop-in.
 */

import {
  DEFAULT_PRESENCE_CACHE_LIMIT,
  DEFAULT_PRESENCE_CACHE_TTL_MS,
  DEFAULT_PRESENCE_NEGATIVE_CACHE_TTL_MS,
} from "../types/types.js";

/** Cache-probe outcome. */
export const PresenceCacheOutcome = Object.freeze({
  HIT: "hit",
  MISS: "miss",
  NEGATIVE: "negative",
  EXPIRED: "expired",
});

export class PresenceCache {
  /**
   * @param {object} [options]
   * @param {() => number} [options.clock]
   * @param {number} [options.ttlMs] positive-entry TTL
   * @param {number} [options.negativeTtlMs] negative-entry TTL
   * @param {number} [options.limit] capacity before LRU eviction
   */
  constructor(options = {}) {
    this._clock = options.clock ?? (() => Date.now());
    this._ttlMs = options.ttlMs ?? DEFAULT_PRESENCE_CACHE_TTL_MS;
    this._negativeTtlMs = options.negativeTtlMs ?? DEFAULT_PRESENCE_NEGATIVE_CACHE_TTL_MS;
    this._limit = options.limit ?? DEFAULT_PRESENCE_CACHE_LIMIT;
    /** @type {Map<string, { value: any, userId: string, negative: boolean, expiresAt: number }>} */
    this._entries = new Map();
    this._stats = { hits: 0, misses: 0, negativeHits: 0, evictions: 0, expirations: 0 };
  }

  /**
   * Probe the cache for a user's resolved presence view.
   * @param {string} userId @returns {{ outcome: string, value: any, negative: boolean }}
   */
  get(userId) {
    const k = String(userId);
    const entry = this._entries.get(k);
    if (!entry) {
      this._stats.misses++;
      return { outcome: PresenceCacheOutcome.MISS, value: null, negative: false };
    }
    if (this._clock() >= entry.expiresAt) {
      this._entries.delete(k);
      this._stats.expirations++;
      this._stats.misses++;
      return { outcome: PresenceCacheOutcome.EXPIRED, value: null, negative: false };
    }
    // Promote to MRU.
    this._entries.delete(k);
    this._entries.set(k, entry);
    if (entry.negative) {
      this._stats.negativeHits++;
      return { outcome: PresenceCacheOutcome.NEGATIVE, value: null, negative: true };
    }
    this._stats.hits++;
    return { outcome: PresenceCacheOutcome.HIT, value: entry.value, negative: false };
  }

  /**
   * Store a resolved presence view for a user. Evicts the LRU entry if over capacity.
   * @param {string} userId @param {any} value @param {{ ttlMs?: number }} [options]
   * @returns {{ evicted: string|null }}
   */
  set(userId, value, options = {}) {
    const k = String(userId);
    const ttl = options.ttlMs ?? this._ttlMs;
    this._entries.delete(k);
    this._entries.set(k, { value, userId: k, negative: false, expiresAt: this._clock() + ttl });
    return this._enforceCapacity();
  }

  /**
   * Record a negative ("no reachable devices") result with the shorter negative TTL.
   * @param {string} userId @param {{ ttlMs?: number }} [options] @returns {{ evicted: string|null }}
   */
  setNegative(userId, options = {}) {
    const k = String(userId);
    const ttl = options.ttlMs ?? this._negativeTtlMs;
    this._entries.delete(k);
    this._entries.set(k, { value: null, userId: k, negative: true, expiresAt: this._clock() + ttl });
    return this._enforceCapacity();
  }

  /** Invalidate a user's cached presence view. @returns {boolean} whether it existed */
  invalidateUser(userId) {
    return this._entries.delete(String(userId));
  }

  /** Prune every expired entry. @param {number} [now] @returns {number} pruned count */
  pruneExpired(now = this._clock()) {
    let pruned = 0;
    for (const [k, entry] of this._entries) {
      if (now >= entry.expiresAt) {
        this._entries.delete(k);
        pruned++;
      }
    }
    this._stats.expirations += pruned;
    return pruned;
  }

  /** Clear the whole cache. */
  clear() {
    this._entries.clear();
  }

  /** Current entry count. @returns {number} */
  get size() {
    return this._entries.size;
  }

  /** A snapshot of cache statistics (for a health/observability panel). */
  stats() {
    const total = this._stats.hits + this._stats.negativeHits + this._stats.misses;
    return {
      ...this._stats,
      size: this._entries.size,
      limit: this._limit,
      hitRate: total === 0 ? 0 : (this._stats.hits + this._stats.negativeHits) / total,
    };
  }

  /** @private Evict the oldest entry while over capacity. */
  _enforceCapacity() {
    let evicted = null;
    while (this._entries.size > this._limit) {
      const oldest = this._entries.keys().next().value;
      this._entries.delete(oldest);
      this._stats.evictions++;
      evicted = oldest;
    }
    return { evicted };
  }
}

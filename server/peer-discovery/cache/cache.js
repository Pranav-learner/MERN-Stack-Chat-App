/**
 * @module peer-discovery/cache
 *
 * The **Discovery Cache** — an in-memory, TTL-bounded, LRU-capped cache of resolved
 * discovery metadata. It makes repeated lookups of the same peer cheap and shields the
 * registry/directory from lookup storms. It supports:
 *
 * - **positive caching** — resolved {@link DiscoveryMetadata} keyed by a lookup key;
 * - **negative caching** — remembered "not found" with a SHORTER TTL, so a missing peer
 *   doesn't hammer the directory but still self-heals quickly;
 * - **TTL expiry** — entries past their TTL are treated as misses and pruned;
 * - **capacity limits** — LRU eviction beyond a configured size;
 * - **invalidation + refresh** — targeted (by user) or whole-cache clearing.
 *
 * @security Cached values are PUBLIC discovery metadata only — no secret key material.
 * The cache is process-local; a future sprint can swap it for a distributed cache behind
 * the same interface (see {@link DiscoveryCache} contract).
 *
 * @evolution The `key` is derived from `(userId, deviceIds)` so a "resolve all devices"
 * result and a "resolve device X" result are cached independently.
 */

import {
  DEFAULT_CACHE_LIMIT,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_NEGATIVE_CACHE_TTL_MS,
  CacheOutcome,
} from "../types/types.js";

/** Build the cache key for a user + optional device subset. */
export function cacheKey(userId, deviceIds = []) {
  const devices = [...(deviceIds ?? [])].map(String).sort().join(",");
  return devices ? `${userId}#${devices}` : String(userId);
}

/**
 * @typedef {object} CacheProbe
 * @property {string} outcome one of {@link CacheOutcome}
 * @property {import("../types/types.js").DiscoveryMetadata|null} value the cached metadata (HIT only)
 * @property {boolean} negative whether this was a cached "not found"
 */

export class DiscoveryCache {
  /**
   * @param {object} [options]
   * @param {() => number} [options.clock]
   * @param {number} [options.ttlMs] positive-entry TTL
   * @param {number} [options.negativeTtlMs] negative-entry TTL
   * @param {number} [options.limit] capacity before LRU eviction
   */
  constructor(options = {}) {
    this._clock = options.clock ?? (() => Date.now());
    this._ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this._negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS;
    this._limit = options.limit ?? DEFAULT_CACHE_LIMIT;
    /** @type {Map<string, { value: object|null, userId: string, negative: boolean, expiresAt: number }>} */
    this._entries = new Map();
    this._stats = { hits: 0, misses: 0, negativeHits: 0, evictions: 0, expirations: 0 };
  }

  /**
   * Probe the cache. Fresh positive → HIT (+ value); fresh negative → NEGATIVE; expired
   * → EXPIRED (entry pruned); absent → MISS. A HIT is promoted to most-recently-used.
   * @param {string} userId @param {string[]} [deviceIds]
   * @returns {CacheProbe}
   */
  get(userId, deviceIds = []) {
    const k = cacheKey(userId, deviceIds);
    const entry = this._entries.get(k);
    if (!entry) {
      this._stats.misses++;
      return { outcome: CacheOutcome.MISS, value: null, negative: false };
    }
    if (this._clock() >= entry.expiresAt) {
      this._entries.delete(k);
      this._stats.expirations++;
      this._stats.misses++;
      return { outcome: CacheOutcome.EXPIRED, value: null, negative: false };
    }
    // Promote to MRU (re-insert).
    this._entries.delete(k);
    this._entries.set(k, entry);
    if (entry.negative) {
      this._stats.negativeHits++;
      return { outcome: CacheOutcome.NEGATIVE, value: null, negative: true };
    }
    this._stats.hits++;
    return { outcome: CacheOutcome.HIT, value: entry.value, negative: false };
  }

  /**
   * Store a resolved metadata result. Evicts the LRU entry if over capacity.
   * @param {string} userId @param {import("../types/types.js").DiscoveryMetadata} value
   * @param {string[]} [deviceIds] @param {{ ttlMs?: number }} [options]
   * @returns {{ evicted: string|null }}
   */
  set(userId, value, deviceIds = [], options = {}) {
    const k = cacheKey(userId, deviceIds);
    const ttl = options.ttlMs ?? this._ttlMs;
    this._entries.delete(k);
    this._entries.set(k, { value, userId: String(userId), negative: false, expiresAt: this._clock() + ttl });
    return this._enforceCapacity();
  }

  /**
   * Record a negative ("not found") result with the negative TTL.
   * @param {string} userId @param {string[]} [deviceIds] @param {{ ttlMs?: number }} [options]
   * @returns {{ evicted: string|null }}
   */
  setNegative(userId, deviceIds = [], options = {}) {
    const k = cacheKey(userId, deviceIds);
    const ttl = options.ttlMs ?? this._negativeTtlMs;
    this._entries.delete(k);
    this._entries.set(k, { value: null, userId: String(userId), negative: true, expiresAt: this._clock() + ttl });
    return this._enforceCapacity();
  }

  /**
   * Invalidate all cache entries for a user (positive + negative). Call when a user's
   * devices change so the next lookup re-resolves. @returns {number} entries removed
   */
  invalidateUser(userId) {
    const uid = String(userId);
    let removed = 0;
    for (const [k, entry] of this._entries) {
      if (entry.userId === uid) {
        this._entries.delete(k);
        removed++;
      }
    }
    return removed;
  }

  /** Invalidate a single (user, deviceIds) key. @returns {boolean} whether it existed */
  invalidate(userId, deviceIds = []) {
    return this._entries.delete(cacheKey(userId, deviceIds));
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

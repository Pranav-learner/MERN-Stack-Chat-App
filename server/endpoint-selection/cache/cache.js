/**
 * @module endpoint-selection/cache
 *
 * The **Endpoint Cache** — an in-memory, TTL-bounded, LRU-capped cache of computed selection
 * artifacts: connection plans, device rankings, selection results, and policy results, all keyed by
 * a candidate-set-aware key. Scoring is a pure function of `(candidates, policy, reliability)`, so a
 * result is safe to cache; the key embeds the candidate device set, so a change in the reachable set
 * naturally re-keys.
 *
 * @security Cached values are PUBLIC selection artifacts — no secret key material. Process-local.
 *
 * @evolution A future distributed deployment swaps this for Redis behind the SAME interface
 * (`get` / `set` / `invalidate` / `invalidateRequester` / `invalidateTarget` / `pruneExpired`).
 */

import { DEFAULT_ES_CACHE_LIMIT, DEFAULT_ES_CACHE_TTL_MS } from "../types/types.js";

/** Cache-probe outcome. */
export const EndpointCacheOutcome = Object.freeze({ HIT: "hit", MISS: "miss", EXPIRED: "expired" });

export class EndpointCache {
  /**
   * @param {object} [options]
   * @param {() => number} [options.clock] @param {number} [options.ttlMs] @param {number} [options.limit]
   */
  constructor(options = {}) {
    this._clock = options.clock ?? (() => Date.now());
    this._ttlMs = options.ttlMs ?? DEFAULT_ES_CACHE_TTL_MS;
    this._limit = options.limit ?? DEFAULT_ES_CACHE_LIMIT;
    /** @type {Map<string, { value: any, requester: string, targetUser: string, expiresAt: number }>} */
    this._entries = new Map();
    this._stats = { hits: 0, misses: 0, evictions: 0, expirations: 0 };
  }

  /** Probe the cache. @param {string} key @returns {{ outcome: string, value: any }} */
  get(key) {
    const entry = this._entries.get(key);
    if (!entry) {
      this._stats.misses++;
      return { outcome: EndpointCacheOutcome.MISS, value: null };
    }
    if (this._clock() >= entry.expiresAt) {
      this._entries.delete(key);
      this._stats.expirations++;
      this._stats.misses++;
      return { outcome: EndpointCacheOutcome.EXPIRED, value: null };
    }
    this._entries.delete(key);
    this._entries.set(key, entry); // promote to MRU
    this._stats.hits++;
    return { outcome: EndpointCacheOutcome.HIT, value: entry.value };
  }

  /**
   * Cache a value. If it carries an `expiresAt`, the entry TTL is capped by it.
   * @param {string} key @param {any} value @param {{ requester?: string, targetUser?: string, ttlMs?: number }} [options]
   * @returns {{ evicted: string|null }}
   */
  set(key, value, options = {}) {
    const ttl = options.ttlMs ?? this._ttlMs;
    let expiresAt = this._clock() + ttl;
    if (value?.expiresAt) expiresAt = Math.min(expiresAt, new Date(value.expiresAt).getTime());
    this._entries.delete(key);
    this._entries.set(key, { value, requester: String(options.requester ?? value?.requester ?? ""), targetUser: String(options.targetUser ?? value?.targetUser ?? ""), expiresAt });
    return this._enforceCapacity();
  }

  /** Invalidate a single key. @returns {boolean} whether it existed */
  invalidate(key) {
    return this._entries.delete(key);
  }

  /** Invalidate every entry for a requester. @returns {number} removed */
  invalidateRequester(requester) {
    return this._invalidateBy((e) => e.requester === String(requester));
  }

  /** Invalidate every entry targeting a user (e.g. when their presence/capabilities change). @returns {number} removed */
  invalidateTarget(targetUser) {
    return this._invalidateBy((e) => e.targetUser === String(targetUser));
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

  /** A snapshot of cache statistics. */
  stats() {
    const total = this._stats.hits + this._stats.misses;
    return { ...this._stats, size: this._entries.size, limit: this._limit, hitRate: total === 0 ? 0 : this._stats.hits / total };
  }

  /** @private */
  _invalidateBy(pred) {
    let removed = 0;
    for (const [k, entry] of this._entries) {
      if (pred(entry)) {
        this._entries.delete(k);
        removed++;
      }
    }
    return removed;
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

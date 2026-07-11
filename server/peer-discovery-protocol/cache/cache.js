/**
 * @module pdp/cache
 *
 * The **Connection Plan Cache** — an in-memory, TTL-bounded, LRU-capped cache of assembled
 * connection plans. Running the full workflow (discovery + presence + capability negotiation +
 * selection) for every request is wasteful when a peer asks repeatedly in a short window; this
 * cache serves a recently-computed plan for an identical request. Its TTL is deliberately SHORT
 * (and ≤ the plan TTL) because presence + capabilities change — a plan is a fresh snapshot, not a
 * durable fact.
 *
 * @security Cached values are PUBLIC connection plans — no secret key material. Process-local.
 *
 * @evolution The underlying subsystems each keep their own cache (discovery, presence, capability),
 * so PDP benefits from caching at every layer. A future distributed deployment swaps this for Redis
 * behind the SAME interface (`get` / `set` / `invalidate` / `invalidateRequester` / `pruneExpired`).
 */

import { DEFAULT_PLAN_CACHE_LIMIT, DEFAULT_PLAN_CACHE_TTL_MS } from "../types/types.js";

/** Cache-probe outcome. */
export const PlanCacheOutcome = Object.freeze({ HIT: "hit", MISS: "miss", EXPIRED: "expired" });

export class ConnectionPlanCache {
  /**
   * @param {object} [options]
   * @param {() => number} [options.clock] @param {number} [options.ttlMs] @param {number} [options.limit]
   */
  constructor(options = {}) {
    this._clock = options.clock ?? (() => Date.now());
    this._ttlMs = options.ttlMs ?? DEFAULT_PLAN_CACHE_TTL_MS;
    this._limit = options.limit ?? DEFAULT_PLAN_CACHE_LIMIT;
    /** @type {Map<string, { value: object, requester: string, expiresAt: number }>} */
    this._entries = new Map();
    this._stats = { hits: 0, misses: 0, evictions: 0, expirations: 0 };
  }

  /**
   * Probe the cache for a connection plan.
   * @param {string} key @returns {{ outcome: string, value: object|null }}
   */
  get(key) {
    const entry = this._entries.get(key);
    if (!entry) {
      this._stats.misses++;
      return { outcome: PlanCacheOutcome.MISS, value: null };
    }
    if (this._clock() >= entry.expiresAt) {
      this._entries.delete(key);
      this._stats.expirations++;
      this._stats.misses++;
      return { outcome: PlanCacheOutcome.EXPIRED, value: null };
    }
    this._entries.delete(key);
    this._entries.set(key, entry); // promote to MRU
    this._stats.hits++;
    return { outcome: PlanCacheOutcome.HIT, value: entry.value };
  }

  /**
   * Cache a connection plan. The plan's own `expiresAt` caps the cache TTL, so a cached plan is
   * never served past its validity. @returns {{ evicted: string|null }}
   */
  set(key, plan, options = {}) {
    const ttl = options.ttlMs ?? this._ttlMs;
    let expiresAt = this._clock() + ttl;
    if (plan?.expiresAt) expiresAt = Math.min(expiresAt, new Date(plan.expiresAt).getTime());
    this._entries.delete(key);
    this._entries.set(key, { value: plan, requester: String(plan?.requester ?? ""), expiresAt });
    return this._enforceCapacity();
  }

  /** Invalidate a single key. @returns {boolean} whether it existed */
  invalidate(key) {
    return this._entries.delete(key);
  }

  /** Invalidate every plan for a requester (e.g. on retry). @returns {number} removed */
  invalidateRequester(requester) {
    const rid = String(requester);
    let removed = 0;
    for (const [k, entry] of this._entries) {
      if (entry.requester === rid) {
        this._entries.delete(k);
        removed++;
      }
    }
    return removed;
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

/**
 * @module group-receipts/cache
 *
 * **Receipt cache.** A small, dependency-free TTL + LRU cache of computed receipt views (tick + counts)
 * keyed by message id, so the read path (which the UI hits constantly for live ticks) avoids
 * recomputation. Because the aggregate is already incremental, the cache stores the last computed view
 * and is INVALIDATED (or refreshed in place) on each aggregate update — no periodic full recompute.
 *
 * It exposes DISTRIBUTED CACHE HOOKS: inject `{ get, set, del }` (e.g. Redis) and the local cache
 * becomes an L1 in front of a shared L2. Fail-open: a distributed-cache error never breaks the receipt
 * path.
 *
 * @security Cached values are receipt DTOs (ticks + counts) ONLY — never content or keys.
 */

import { DEFAULT_CACHE_TTL_MS, DEFAULT_CACHE_MAX } from "../types/types.js";

export class ReceiptCache {
  /** @param {{ ttlMs?: number, max?: number, clock?: () => number, distributed?: { get, set, del } }} [options] */
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this.max = options.max ?? DEFAULT_CACHE_MAX;
    this.clock = options.clock ?? (() => Date.now());
    this.distributed = options.distributed ?? null;
    this._map = new Map(); // messageId → { value, expiresAt }
    this._stats = { hits: 0, misses: 0, sets: 0, evictions: 0, invalidations: 0 };
  }

  /** Get a cached receipt view (L1 → L2). @returns {Promise<object|null>} */
  async get(messageId) {
    const key = String(messageId);
    const entry = this._map.get(key);
    if (entry && entry.expiresAt > this.clock()) {
      // refresh LRU recency
      this._map.delete(key);
      this._map.set(key, entry);
      this._stats.hits++;
      return entry.value;
    }
    if (entry) this._map.delete(key);
    if (this.distributed?.get) {
      try {
        const remote = await this.distributed.get(key);
        if (remote != null) {
          this._setLocal(key, remote);
          this._stats.hits++;
          return remote;
        }
      } catch {
        /* fail-open */
      }
    }
    this._stats.misses++;
    return null;
  }

  /** Set (refresh) a cached receipt view (write-through to L2). */
  async set(messageId, value) {
    const key = String(messageId);
    this._setLocal(key, value);
    this._stats.sets++;
    if (this.distributed?.set) {
      try {
        await this.distributed.set(key, value, this.ttlMs);
      } catch {
        /* fail-open */
      }
    }
    return value;
  }

  /** Invalidate a message's cached view (on aggregate change). */
  async invalidate(messageId) {
    const key = String(messageId);
    this._map.delete(key);
    this._stats.invalidations++;
    if (this.distributed?.del) {
      try {
        await this.distributed.del(key);
      } catch {
        /* fail-open */
      }
    }
  }

  /** Incrementally refresh a cached view in place (the aggregate already did the O(1) work). */
  async refresh(messageId, value) {
    return this.set(messageId, value);
  }

  stats() {
    const total = this._stats.hits + this._stats.misses;
    return { ...this._stats, size: this._map.size, hitRate: total ? Number((this._stats.hits / total).toFixed(4)) : 0 };
  }

  clear() {
    this._map.clear();
  }

  _setLocal(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, { value, expiresAt: this.clock() + this.ttlMs });
    while (this._map.size > this.max) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
      this._stats.evictions++;
    }
  }
}

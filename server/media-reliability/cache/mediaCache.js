/**
 * @module media-reliability/cache
 *
 * **Media hot-metadata cache** — a dependency-free TTL + LRU cache of hot media control-plane metadata
 * (media DTOs, delivery diagnostics, availability views) with HIT-RATE observability, plus DISTRIBUTED
 * cache hooks. It fronts the frequently-read paths so a production media library (millions of objects)
 * doesn't hit the repository/storage on every render. The reliability manager records each access into
 * {@link module:media-reliability/monitoring/metrics MediaMetrics} so `cache hit rate` is a first-class
 * metric.
 *
 * @security Caches media METADATA + numeric views ONLY — never ciphertext or keys. Fail-open on a
 * distributed-cache error (a cache blip never breaks the media path).
 */

import { DEFAULT_CACHE_TTL_MS, DEFAULT_CACHE_MAX } from "../types/types.js";

export class MediaCache {
  /** @param {{ ttlMs?: number, max?: number, clock?: () => number, distributed?: { get, set, del }, metrics?: object }} [options] */
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this.max = options.max ?? DEFAULT_CACHE_MAX;
    this.clock = options.clock ?? (() => Date.now());
    this.distributed = options.distributed ?? null;
    this.metrics = options.metrics ?? null;
    this._map = new Map(); // key → { value, expiresAt }
    this._stats = { hits: 0, misses: 0, sets: 0, evictions: 0 };
  }

  /** Get a cached value (L1 → L2). Records a hit/miss into metrics. @returns {Promise<any|null>} */
  async get(key) {
    const k = String(key);
    const entry = this._map.get(k);
    if (entry && entry.expiresAt > this.clock()) {
      this._map.delete(k);
      this._map.set(k, entry); // LRU bump
      this._hit();
      return entry.value;
    }
    if (entry) this._map.delete(k);
    if (this.distributed?.get) {
      try {
        const remote = await this.distributed.get(k);
        if (remote != null) {
          this._setLocal(k, remote);
          this._hit();
          return remote;
        }
      } catch {
        /* fail-open */
      }
    }
    this._miss();
    return null;
  }

  /** Set (write-through to L2). */
  async set(key, value) {
    const k = String(key);
    this._setLocal(k, value);
    this._stats.sets++;
    if (this.distributed?.set) {
      try {
        await this.distributed.set(k, value, this.ttlMs);
      } catch {
        /* fail-open */
      }
    }
    return value;
  }

  /** Read-through helper: return the cached value or compute + cache it. */
  async getOrLoad(key, loader) {
    const cached = await this.get(key);
    if (cached != null) return cached;
    const value = await loader();
    if (value != null) await this.set(key, value);
    return value;
  }

  /** Invalidate a key (on media mutation / deletion). */
  async invalidate(key) {
    const k = String(key);
    this._map.delete(k);
    if (this.distributed?.del) {
      try {
        await this.distributed.del(k);
      } catch {
        /* fail-open */
      }
    }
  }

  hitRate() {
    const total = this._stats.hits + this._stats.misses;
    return total ? Number((this._stats.hits / total).toFixed(4)) : 0;
  }

  stats() {
    return { ...this._stats, size: this._map.size, hitRate: this.hitRate() };
  }

  clear() {
    this._map.clear();
  }

  _hit() {
    this._stats.hits++;
    this.metrics?.recordCache?.(true);
  }
  _miss() {
    this._stats.misses++;
    this.metrics?.recordCache?.(false);
  }
  _setLocal(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, { value, expiresAt: this.clock() + this.ttlMs });
    while (this._map.size > this.max) {
      this._map.delete(this._map.keys().next().value);
      this._stats.evictions++;
    }
  }
}

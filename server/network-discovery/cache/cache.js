/**
 * @module network-discovery/cache
 *
 * The **Network Profile Cache** — an in-memory, TTL-bounded, LRU-capped cache of discovered network
 * profiles keyed by device. Discovery (interface enumeration + STUN round-trips) is comparatively
 * expensive, so a fresh profile is cached to serve repeat reads; the TTL is bounded by the profile's
 * own expiry because the network can change.
 *
 * @security Cached values are PUBLIC network profiles — no secret key material. Process-local.
 *
 * @evolution A future distributed deployment swaps this for Redis behind the SAME interface
 * (`get` / `set` / `invalidate` / `invalidateDevice` / `pruneExpired`).
 */

import { DEFAULT_CACHE_LIMIT, DEFAULT_CACHE_TTL_MS } from "../types/types.js";

/** Cache-probe outcome. */
export const CacheOutcome = Object.freeze({ HIT: "hit", MISS: "miss", EXPIRED: "expired" });

export class NetworkProfileCache {
  /** @param {{ clock?: () => number, ttlMs?: number, limit?: number }} [options] */
  constructor(options = {}) {
    this._clock = options.clock ?? (() => Date.now());
    this._ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this._limit = options.limit ?? DEFAULT_CACHE_LIMIT;
    /** @type {Map<string, { value: object, deviceId: string, expiresAt: number }>} */
    this._entries = new Map();
    this._stats = { hits: 0, misses: 0, evictions: 0, expirations: 0 };
  }

  /** Probe by cache key. @param {string} key @returns {{ outcome: string, value: object|null }} */
  get(key) {
    const entry = this._entries.get(key);
    if (!entry) {
      this._stats.misses++;
      return { outcome: CacheOutcome.MISS, value: null };
    }
    if (this._clock() >= entry.expiresAt) {
      this._entries.delete(key);
      this._stats.expirations++;
      this._stats.misses++;
      return { outcome: CacheOutcome.EXPIRED, value: null };
    }
    this._entries.delete(key);
    this._entries.set(key, entry); // promote to MRU
    this._stats.hits++;
    return { outcome: CacheOutcome.HIT, value: entry.value };
  }

  /** Store a profile. The entry TTL is capped by the profile's own `expiresAt`. */
  set(key, profile, options = {}) {
    const ttl = options.ttlMs ?? this._ttlMs;
    let expiresAt = this._clock() + ttl;
    if (profile?.expiresAt) expiresAt = Math.min(expiresAt, new Date(profile.expiresAt).getTime());
    this._entries.delete(key);
    this._entries.set(key, { value: profile, deviceId: String(profile?.deviceId ?? ""), expiresAt });
    return this._enforceCapacity();
  }

  /** Invalidate a single key. @returns {boolean} */
  invalidate(key) {
    return this._entries.delete(key);
  }

  /** Invalidate every entry for a device (on a network change / refresh). @returns {number} removed */
  invalidateDevice(deviceId) {
    const did = String(deviceId);
    let removed = 0;
    for (const [k, e] of this._entries) if (e.deviceId === did) { this._entries.delete(k); removed++; }
    return removed;
  }

  /** Prune every expired entry. @returns {number} pruned */
  pruneExpired(now = this._clock()) {
    let pruned = 0;
    for (const [k, e] of this._entries) if (now >= e.expiresAt) { this._entries.delete(k); pruned++; }
    this._stats.expirations += pruned;
    return pruned;
  }

  /** Clear the cache. */
  clear() {
    this._entries.clear();
  }

  /** Current entry count. */
  get size() {
    return this._entries.size;
  }

  /** Cache statistics snapshot. */
  stats() {
    const total = this._stats.hits + this._stats.misses;
    return { ...this._stats, size: this._entries.size, limit: this._limit, hitRate: total === 0 ? 0 : this._stats.hits / total };
  }

  /** @private */
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

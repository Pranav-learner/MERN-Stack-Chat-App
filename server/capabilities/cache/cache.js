/**
 * @module capabilities/cache
 *
 * The **Capability Cache** — an in-memory, TTL-bounded, LRU-capped, **version-aware** cache of
 * negotiation results. Negotiation is a pure function of two capability sets, so its result is
 * safe to cache keyed by the two devices AND their capability versions
 * ({@link module:capabilities/negotiation.negotiationKey}). Because the key embeds each device's
 * `version`, a capability UPDATE (which bumps the version) automatically produces a new key — the
 * old result is never served again. Explicit `invalidateDevice` additionally evicts stale entries
 * to bound memory.
 *
 * It supports positive + **negative** caching (an incompatible pair is remembered briefly so a
 * repeated negotiation is cheap), TTL expiry, targeted invalidation, and LRU eviction.
 *
 * @security Cached values are PUBLIC negotiation results — versions, transport names, flags. No
 * secret key material.
 *
 * @evolution A future distributed deployment swaps this for Redis behind the SAME interface
 * (`get` / `set` / `setNegative` / `invalidateDevice` / `pruneExpired`) — the version-aware key
 * makes cross-node invalidation trivial (updates simply mint new keys).
 */

import {
  DEFAULT_CAPABILITY_CACHE_LIMIT,
  DEFAULT_NEGOTIATION_CACHE_TTL_MS,
  DEFAULT_NEGOTIATION_NEGATIVE_CACHE_TTL_MS,
} from "../types/types.js";

/** Cache-probe outcome. */
export const CapabilityCacheOutcome = Object.freeze({
  HIT: "hit",
  MISS: "miss",
  NEGATIVE: "negative",
  EXPIRED: "expired",
});

export class CapabilityCache {
  /**
   * @param {object} [options]
   * @param {() => number} [options.clock]
   * @param {number} [options.ttlMs] positive-entry TTL
   * @param {number} [options.negativeTtlMs] negative-entry TTL
   * @param {number} [options.limit] capacity before LRU eviction
   */
  constructor(options = {}) {
    this._clock = options.clock ?? (() => Date.now());
    this._ttlMs = options.ttlMs ?? DEFAULT_NEGOTIATION_CACHE_TTL_MS;
    this._negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGOTIATION_NEGATIVE_CACHE_TTL_MS;
    this._limit = options.limit ?? DEFAULT_CAPABILITY_CACHE_LIMIT;
    /** @type {Map<string, { value: any, devices: string[], negative: boolean, expiresAt: number }>} */
    this._entries = new Map();
    this._stats = { hits: 0, misses: 0, negativeHits: 0, evictions: 0, expirations: 0 };
  }

  /**
   * Probe the cache for a negotiation result.
   * @param {string} key a version-aware negotiation key
   * @returns {{ outcome: string, value: any, negative: boolean }}
   */
  get(key) {
    const entry = this._entries.get(key);
    if (!entry) {
      this._stats.misses++;
      return { outcome: CapabilityCacheOutcome.MISS, value: null, negative: false };
    }
    if (this._clock() >= entry.expiresAt) {
      this._entries.delete(key);
      this._stats.expirations++;
      this._stats.misses++;
      return { outcome: CapabilityCacheOutcome.EXPIRED, value: null, negative: false };
    }
    this._entries.delete(key);
    this._entries.set(key, entry); // promote to MRU
    if (entry.negative) {
      this._stats.negativeHits++;
      return { outcome: CapabilityCacheOutcome.NEGATIVE, value: null, negative: true };
    }
    this._stats.hits++;
    return { outcome: CapabilityCacheOutcome.HIT, value: entry.value, negative: false };
  }

  /**
   * Cache a negotiation result. `devices` are the two device keys (`user:device`) it touches — used
   * for targeted invalidation. @returns {{ evicted: string|null }}
   */
  set(key, value, devices = [], options = {}) {
    const ttl = options.ttlMs ?? this._ttlMs;
    this._entries.delete(key);
    this._entries.set(key, { value, devices: [...devices], negative: false, expiresAt: this._clock() + ttl });
    return this._enforceCapacity();
  }

  /** Cache a negative ("incompatible") result with the shorter negative TTL. */
  setNegative(key, devices = [], options = {}) {
    const ttl = options.ttlMs ?? this._negativeTtlMs;
    this._entries.delete(key);
    this._entries.set(key, { value: null, devices: [...devices], negative: true, expiresAt: this._clock() + ttl });
    return this._enforceCapacity();
  }

  /**
   * Invalidate every cached result touching a device (call when its capabilities change).
   * @param {string} deviceKey `user:device` @returns {number} entries removed
   */
  invalidateDevice(deviceKey) {
    let removed = 0;
    for (const [k, entry] of this._entries) {
      if (entry.devices.includes(deviceKey)) {
        this._entries.delete(k);
        removed++;
      }
    }
    return removed;
  }

  /** Invalidate a single key. @returns {boolean} whether it existed */
  invalidate(key) {
    return this._entries.delete(key);
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

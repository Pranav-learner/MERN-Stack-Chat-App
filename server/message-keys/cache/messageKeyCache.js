/**
 * @module message-keys/cache
 *
 * Device-local **skipped-message-key cache**. When messages arrive out of order, the receiver
 * derives message keys for the skipped indexes and caches them here until the awaited messages
 * arrive (or they expire). This is part of the symmetric-key ratchet — NOT a Double Ratchet.
 *
 * @security Cached keys are still SECRET, device-local material — this store is never
 * serialized. Keys are destroyed (zero-filled) when taken for use, when they expire, or on
 * teardown. The cache is bounded (size + TTL) to prevent a resource-exhaustion / DoS attack
 * via a flood of out-of-order message numbers.
 */

import { destroyMessageKey } from "../destruction/destruction.js";
import { DEFAULT_CACHE_LIMIT, DEFAULT_CACHE_TTL_MS } from "../types/types.js";

const key = (sessionId, direction, generation, number) => `${sessionId}|${direction}|${generation}|${number}`;

export class MessageKeyCache {
  /** @param {{ clock?: () => number, limit?: number, ttlMs?: number }} [options] */
  constructor(options = {}) {
    this._clock = options.clock ?? (() => Date.now());
    this._limit = options.limit ?? DEFAULT_CACHE_LIMIT;
    this._ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    /** @type {Map<string, { bundle: object, sessionId: string, at: number }>} */
    this._entries = new Map();
  }

  /**
   * Cache a skipped message key. Evicts (and destroys) the oldest entry if over the limit.
   * @returns {{ evicted: object|null }} the destruction record of any evicted key
   */
  put(sessionId, direction, generation, number, bundle) {
    const k = key(sessionId, direction, generation, number);
    this._entries.set(k, { bundle, sessionId: String(sessionId), at: this._clock() });
    let evicted = null;
    if (this._entries.size > this._limit) {
      const oldestKey = this._entries.keys().next().value;
      const oldest = this._entries.get(oldestKey);
      this._entries.delete(oldestKey);
      evicted = destroyMessageKey(oldest.bundle, { reason: "cache-evicted", at: new Date(this._clock()).toISOString() });
    }
    return { evicted };
  }

  /**
   * Take a cached message key for use (removes it from the cache; caller must destroy it after
   * use). Returns null if absent. @returns {object|null} the bundle
   */
  take(sessionId, direction, generation, number) {
    const k = key(sessionId, direction, generation, number);
    const entry = this._entries.get(k);
    if (!entry) return null;
    this._entries.delete(k);
    return entry.bundle;
  }

  /** Whether a skipped key is cached. */
  has(sessionId, direction, generation, number) {
    return this._entries.has(key(sessionId, direction, generation, number));
  }

  /**
   * Destroy cached keys older than the TTL. @param {number} [now] @returns {object[]} destruction records
   */
  pruneExpired(now = this._clock()) {
    const records = [];
    for (const [k, entry] of this._entries) {
      if (now - entry.at >= this._ttlMs) {
        records.push(destroyMessageKey(entry.bundle, { reason: "expired", at: new Date(now).toISOString() }));
        this._entries.delete(k);
      }
    }
    return records;
  }

  /** Securely destroy all cached keys for a session. @returns {number} count destroyed */
  destroySession(sessionId) {
    const sid = String(sessionId);
    let count = 0;
    for (const [k, entry] of this._entries) {
      if (entry.sessionId === sid) {
        destroyMessageKey(entry.bundle, { reason: "session-ended" });
        this._entries.delete(k);
        count++;
      }
    }
    return count;
  }

  /** Total cached keys. */
  get size() {
    return this._entries.size;
  }

  /** Destroy everything. */
  destroyAll() {
    for (const entry of this._entries.values()) destroyMessageKey(entry.bundle, { reason: "clear" });
    this._entries.clear();
  }
}

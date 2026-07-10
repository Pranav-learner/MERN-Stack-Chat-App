/**
 * @module shs/hardening/replay/replayCache
 *
 * A time-bounded replay cache. Records the identifiers already seen (nonces,
 * message ids, handshake ids) with a TTL, so a replayed message/handshake is
 * rejected while the record is live and the memory is reclaimed after it expires.
 *
 * Implements the `.has(key)` / `.add(key)` shape the Sprint 1 validators'
 * {@link module:shs/validators} `assertNotDuplicate` expects, so it drops in as the
 * `seen` set — but with expiry + capacity bounds + eviction events.
 *
 * @security The cache stores only opaque PUBLIC identifiers. It is an in-process
 * structure; a multi-node deployment shares one via a distributed backend (a future
 * hook — the contract is `has`/`add`/`prune`).
 */

/**
 * @typedef {object} ReplayCacheOptions
 * @property {number} [ttlMs=120000] how long a key is remembered (default 2m)
 * @property {number} [maxEntries=100000] hard cap; oldest are evicted past it
 * @property {() => number} [clock]
 * @property {(key: string, reason: string) => void} [onEvict] eviction hook
 */

/** A bounded, TTL'd set of seen identifiers. */
export class ReplayCache {
  /** @param {ReplayCacheOptions} [options] */
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? 120_000;
    this.maxEntries = options.maxEntries ?? 100_000;
    this.clock = options.clock ?? (() => Date.now());
    this.onEvict = options.onEvict ?? null;
    /** @type {Map<string, number>} key -> expiry epoch ms (insertion-ordered). */
    this._entries = new Map();
  }

  /**
   * Whether a key is currently remembered (and not expired). Lazily prunes the key if
   * it has expired.
   * @param {string} key @returns {boolean}
   */
  has(key) {
    const expiry = this._entries.get(key);
    if (expiry === undefined) return false;
    if (this.clock() >= expiry) {
      this._entries.delete(key);
      this._evicted(key, "expired");
      return false;
    }
    return true;
  }

  /**
   * Remember a key until now + ttl. Enforces the capacity cap by evicting the oldest.
   * @param {string} key @param {number} [ttlMs] per-entry override
   * @returns {boolean} true if newly added, false if it was already present (a replay)
   */
  add(key, ttlMs) {
    const replay = this.has(key);
    this._entries.delete(key); // re-insert to keep insertion order = recency
    this._entries.set(key, this.clock() + (ttlMs ?? this.ttlMs));
    this._enforceCapacity();
    return !replay;
  }

  /** Remember multiple keys atomically; returns false if ANY was already present. */
  addAll(keys, ttlMs) {
    let allNew = true;
    for (const key of keys) {
      if (!this.add(key, ttlMs)) allNew = false;
    }
    return allNew;
  }

  /** Remove expired entries eagerly. Returns the number pruned. */
  prune() {
    const now = this.clock();
    let pruned = 0;
    for (const [key, expiry] of this._entries) {
      if (now >= expiry) {
        this._entries.delete(key);
        this._evicted(key, "expired");
        pruned++;
      }
    }
    return pruned;
  }

  /** Current live+stale entry count (call {@link prune} first for a live count). */
  get size() {
    return this._entries.size;
  }

  /** Clear the whole cache. */
  clear() {
    this._entries.clear();
  }

  /** @private Evict oldest entries beyond the capacity cap. */
  _enforceCapacity() {
    while (this._entries.size > this.maxEntries) {
      const oldest = this._entries.keys().next().value;
      this._entries.delete(oldest);
      this._evicted(oldest, "capacity");
    }
  }

  /** @private */
  _evicted(key, reason) {
    if (this.onEvict) {
      try {
        this.onEvict(key, reason);
      } catch {
        /* eviction hooks must never break the cache */
      }
    }
  }
}

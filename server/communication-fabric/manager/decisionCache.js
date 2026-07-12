/**
 * @module communication-fabric/manager/decisionCache
 *
 * A small **TTL + LRU decision cache** (STEP 15 performance). Identical decision INPUTS — same
 * communication type, conversation shape, media type, priority, availability, sync posture, force flags,
 * and policy overrides — deterministically produce the same decision, so the engine's output (minus the
 * per-request ids/timestamps) can be memoized. On a hit the manager re-stamps a fresh decisionId +
 * requestId, so cache reuse never conflates two requests' identities.
 *
 * @performance O(1) get/set. Bounded by `max` (LRU eviction) and `ttlMs` (lazy expiry on read). No timers.
 * @evolution The cache key deliberately excludes live signals (network/battery); when Sprint 2 makes
 * decisions depend on those, it either extends the key or bypasses the cache for adaptive requests.
 */

export class DecisionCache {
  /** @param {object} [opts] @param {number} [opts.ttlMs] @param {number} [opts.max] @param {() => number} [opts.clock] */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? 15_000;
    this.max = opts.max ?? 5_000;
    this.clock = opts.clock ?? (() => Date.now());
    /** @type {Map<string, { value: any, expiresAt: number }>} insertion order = LRU order */
    this._map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Build a stable cache key from a context + policy overrides. Only the decision-relevant facets are
   * included, so semantically-identical requests collide (the desired behaviour).
   */
  static keyFor(context, overrides = {}) {
    const raw = context.raw ?? context;
    return JSON.stringify({
      t: raw.type,
      c: raw.conversation.type,
      g: !!raw.conversation.groupId,
      m: raw.media.type,
      p: raw.transport.priority,
      a: raw.recipient.availability,
      s: raw.synchronization.state,
      fr: raw.metadata?.forceRelay === true,
      fh: raw.metadata?.forceHybrid === true,
      o: overrides ?? {},
    });
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= this.clock()) {
      this._map.delete(key);
      this.misses++;
      return undefined;
    }
    // refresh LRU recency
    this._map.delete(key);
    this._map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, { value, expiresAt: this.clock() + this.ttlMs });
    while (this._map.size > this.max) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
  }

  clear() {
    this._map.clear();
  }

  stats() {
    const total = this.hits + this.misses;
    return { size: this._map.size, max: this.max, hits: this.hits, misses: this.misses, hitRate: total ? this.hits / total : 0 };
  }
}

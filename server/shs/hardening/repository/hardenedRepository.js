/**
 * @module shs/hardening/repository/hardenedRepository
 *
 * Repository hardening. Wraps any single-entity repository (the Sprint 1–3 in-memory
 * or Mongo repos) to add production safety WITHOUT changing its contract:
 *
 *   - **Concurrency / race safety** — a per-key async mutex serializes read-modify-write
 *     sequences so two interleaved async operations on the same entity cannot clobber
 *     each other (the single-threaded-Node analogue of thread safety).
 *   - **Optimistic concurrency** — an optional `_rev` compare-and-set guards blind
 *     overwrites across nodes.
 *   - **Idempotent create** — a repeated `create` for the same id is detected.
 *   - **Read caching** — a tiny TTL cache over `findById`.
 *   - **Write validation** — an injectable validator runs before every write.
 *
 * @security No secrets. The wrapper is transparent — callers use the same methods.
 */

import { ConcurrencyConflictError } from "../errors.js";

/**
 * A fair per-key async mutex: operations for the same key run one-at-a-time in arrival
 * order; different keys run concurrently.
 */
export class KeyedMutex {
  constructor() {
    /** @type {Map<string, Promise<void>>} key -> tail of its queue */
    this._tails = new Map();
  }

  /**
   * Run `fn` with exclusive access for `key`.
   * @template T @param {string} key @param {() => Promise<T>} fn @returns {Promise<T>}
   */
  async run(key, fn) {
    const prev = this._tails.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const mine = prev.then(() => gate);
    this._tails.set(key, mine);
    await prev; // wait our turn
    try {
      return await fn();
    } finally {
      release();
      // Clean up if we are still the tail (no one queued behind us).
      if (this._tails.get(key) === mine) this._tails.delete(key);
    }
  }

  /** Number of keys with pending/active work. */
  get size() {
    return this._tails.size;
  }
}

/** Tiny TTL cache for reads. */
class TtlCache {
  constructor(ttlMs, clock) {
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.ttlMs > 0 && this.clock() >= e.exp) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }
  set(key, value) {
    this.map.set(key, { value, exp: this.clock() + this.ttlMs });
  }
  delete(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

/**
 * Wrap a single-entity repository with hardening. The wrapped repo must expose
 * `create(record)`, `findById(id)`, `update(id, patch)`, `delete(id)`; any other
 * methods pass through unchanged.
 *
 * @param {object} repo the repository to wrap
 * @param {object} [options]
 * @param {(record: object) => string} [options.idOf] extract the id from a record (default `r.id ?? r.sessionId ?? r.handshakeId`)
 * @param {(record: object) => void} [options.validate] throws to reject a write
 * @param {number} [options.cacheTtlMs=0] read cache TTL (0 = disabled)
 * @param {boolean} [options.optimistic=false] enforce `_rev` compare-and-set on update
 * @param {() => number} [options.clock]
 * @returns {object} a hardened repository with the same contract
 */
export function hardenRepository(repo, options = {}) {
  const idOf = options.idOf ?? ((r) => r.id ?? r.sessionId ?? r.handshakeId);
  const clock = options.clock ?? (() => Date.now());
  const cache = new TtlCache(options.cacheTtlMs ?? 0, clock);
  const mutex = new KeyedMutex();
  const validate = options.validate ?? null;
  const optimistic = options.optimistic ?? false;

  const hardened = Object.create(repo); // pass through unknown methods

  hardened.mutex = mutex;

  hardened.create = (record) => {
    const id = String(idOf(record));
    return mutex.run(id, async () => {
      if (validate) validate(record);
      const existing = await repo.findById(id);
      if (existing) {
        throw new ConcurrencyConflictError("Record already exists (idempotent create)", { details: { id } });
      }
      const toStore = optimistic ? { ...record, _rev: 0 } : record;
      const created = await repo.create(toStore);
      cache.set(id, created);
      return created;
    });
  };

  hardened.findById = async (id) => {
    const cached = cache.get(String(id));
    if (cached !== undefined) return cached;
    const record = await repo.findById(id);
    if (record) cache.set(String(id), record);
    return record;
  };

  hardened.update = (id, patch) => {
    const key = String(id);
    return mutex.run(key, async () => {
      const current = await repo.findById(id); // single read under the lock
      if (optimistic && patch._rev !== undefined && current?._rev !== undefined && current._rev !== patch._rev) {
        throw new ConcurrencyConflictError("Stale write (optimistic lock)", { details: { id, expected: patch._rev, actual: current._rev } });
      }
      const nextPatch = optimistic ? { ...patch, _rev: (current?._rev ?? 0) + 1 } : patch;
      if (validate) validate({ ...current, ...nextPatch });
      const updated = await repo.update(id, nextPatch);
      cache.set(key, updated);
      return updated;
    });
  };

  hardened.delete = (id) => {
    const key = String(id);
    return mutex.run(key, async () => {
      cache.delete(key);
      return repo.delete(id);
    });
  };

  /** Bust the read cache for an id (or all). */
  hardened.invalidate = (id) => (id ? cache.delete(String(id)) : cache.clear());

  return hardened;
}

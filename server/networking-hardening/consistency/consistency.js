/**
 * @module networking-hardening/consistency
 *
 * **Distributed-consistency primitives** for the networking control plane. In a horizontally-scaled
 * deployment many instances read + write the same discovery / presence / capability / plan records
 * concurrently. This module provides the small, storage-agnostic tools that keep those writes
 * correct: optimistic-concurrency version checks, deterministic conflict resolution, and an
 * idempotency store so a duplicated request produces one effect.
 *
 * @security Consistency operates on METADATA + version counters only — never key material.
 *
 * @distributed These are the seams a distributed backend uses: `assertVersion` maps onto a
 * compare-and-set / conditional write; `resolveConflict` is a deterministic merge both replicas
 * compute identically; the idempotency store maps onto a shared (e.g. Redis) key with a TTL.
 */

import { DEFAULT_IDEMPOTENCY_TTL_MS, HardeningEventType } from "../types/types.js";
import { ConsistencyConflictError } from "../errors.js";
import { HardeningEventBus } from "../events/events.js";

/**
 * Assert an optimistic-concurrency precondition: the record's current `version` must equal the
 * `expected` version the writer read. Use before a conditional write (compare-and-set).
 * @param {number} current the record's current version @param {number} expected the version the writer based its change on
 * @throws {ConsistencyConflictError} when they disagree (a concurrent write intervened).
 */
export function assertVersion(current, expected) {
  if (expected !== undefined && Number(current) !== Number(expected)) {
    throw new ConsistencyConflictError("Version precondition failed (concurrent update)", {
      details: { current, expected },
    });
  }
  return true;
}

/** Whether an incoming version is newer than the stored one (monotonic-version validation). */
export function isNewerVersion(incoming, stored) {
  return Number(incoming ?? 0) > Number(stored ?? 0);
}

/**
 * Deterministically resolve a conflict between two versions of a record. Both replicas, given the
 * same pair, compute the SAME winner — so it converges without coordination.
 *
 * Strategy: higher `version` wins; on a version tie, the later `updatedAt` wins; on a further tie,
 * a stable id comparison decides. Emits `CONFLICT_RESOLVED`.
 *
 * @param {object} a @param {object} b
 * @param {{ events?: HardeningEventBus, idField?: string }} [options]
 * @returns {{ winner: object, loser: object, reason: string }}
 */
export function resolveConflict(a, b, options = {}) {
  const idField = options.idField ?? "planId";
  const events = options.events;
  const decide = () => {
    const va = Number(a?.version ?? 0);
    const vb = Number(b?.version ?? 0);
    if (va !== vb) return va > vb ? ["a", "higher-version"] : ["b", "higher-version"];
    const ta = new Date(a?.updatedAt ?? 0).getTime();
    const tb = new Date(b?.updatedAt ?? 0).getTime();
    if (ta !== tb) return ta > tb ? ["a", "later-timestamp"] : ["b", "later-timestamp"];
    // Deterministic final tie-break by id (so both replicas agree).
    const ia = String(a?.[idField] ?? "");
    const ib = String(b?.[idField] ?? "");
    return ia >= ib ? ["a", "id-tiebreak"] : ["b", "id-tiebreak"];
  };
  const [which, reason] = decide();
  const winner = which === "a" ? a : b;
  const loser = which === "a" ? b : a;
  events?.emit(HardeningEventType.CONFLICT_RESOLVED, { reason, details: { winner: winner?.[idField], loser: loser?.[idField] } });
  return { winner, loser, reason };
}

/**
 * A TTL-bounded **idempotency store**: memoizes the result of an operation by an idempotency key so
 * a retried/duplicated request produces exactly one effect and returns the same result.
 *
 * @example
 * ```js
 * const store = new IdempotencyStore();
 * const plan = await store.run(idemKey, () => manager.generateConnectionPlan(req));
 * // a second run(idemKey, ...) within the TTL returns the SAME plan without re-running.
 * ```
 */
export class IdempotencyStore {
  /** @param {{ clock?: () => number, ttlMs?: number, limit?: number }} [options] */
  constructor(options = {}) {
    this._clock = options.clock ?? (() => Date.now());
    this._ttlMs = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this._limit = options.limit ?? 10_000;
    /** @type {Map<string, { value: any, expiresAt: number }>} */
    this._entries = new Map();
    /** @type {Map<string, Promise<any>>} in-flight coalescing */
    this._inflight = new Map();
  }

  /** The cached result for a key, or undefined (also prunes if expired). */
  get(key) {
    const e = this._entries.get(String(key));
    if (!e) return undefined;
    if (this._clock() >= e.expiresAt) {
      this._entries.delete(String(key));
      return undefined;
    }
    return e.value;
  }

  /** Store a result for a key. */
  set(key, value, ttlMs) {
    this._entries.set(String(key), { value, expiresAt: this._clock() + (ttlMs ?? this._ttlMs) });
    while (this._entries.size > this._limit) this._entries.delete(this._entries.keys().next().value);
    return value;
  }

  /**
   * Run `fn` at most once per key within the TTL. A cached result is returned immediately; a
   * concurrent duplicate awaits the same in-flight promise (coalesced). If no key is given, `fn`
   * runs normally (no memoization).
   * @param {string|undefined} key @param {() => Promise<any>} fn @returns {Promise<any>}
   */
  async run(key, fn) {
    if (!key) return fn();
    const k = String(key);
    const cached = this.get(k);
    if (cached !== undefined) return cached;
    if (this._inflight.has(k)) return this._inflight.get(k);
    const promise = Promise.resolve()
      .then(fn)
      .then((value) => {
        this.set(k, value);
        return value;
      })
      .finally(() => this._inflight.delete(k));
    this._inflight.set(k, promise);
    return promise;
  }

  /** Number of cached results. */
  get size() {
    return this._entries.size;
  }

  /** Clear the store. */
  clear() {
    this._entries.clear();
    this._inflight.clear();
  }
}

/**
 * A tiny compare-and-set helper over a repository with `findById` + `update`. Reads the record,
 * asserts the expected version, applies a pure `mutate`, and writes with a bumped version. Retries
 * a bounded number of times on a version conflict (read-modify-write loop).
 *
 * @param {object} repo a repo with `findById(id)` + `update(id, patch)`
 * @param {string} id @param {(record: object) => object} mutate returns the patch to apply
 * @param {{ maxAttempts?: number, versionField?: string }} [options]
 * @returns {Promise<object>} the updated record
 * @throws {ConsistencyConflictError} if it cannot converge within `maxAttempts`.
 */
export async function compareAndSet(repo, id, mutate, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  const vf = options.versionField ?? "version";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const current = await repo.findById(id);
    if (!current) throw new ConsistencyConflictError("Record vanished during compare-and-set", { details: { id } });
    const baseVersion = current[vf] ?? 0;
    const patch = { ...mutate(current), [vf]: baseVersion + 1 };
    try {
      const after = await repo.findById(id);
      assertVersion(after?.[vf] ?? 0, baseVersion); // still unchanged?
      return await repo.update(id, patch);
    } catch (error) {
      if (!(error instanceof ConsistencyConflictError) || attempt === maxAttempts) throw error;
    }
  }
  throw new ConsistencyConflictError("compare-and-set could not converge", { details: { id, maxAttempts } });
}

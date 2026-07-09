/**
 * @module cache
 *
 * In-memory key cache sitting in front of storage. Future modules access keys
 * through a repository, which consults the cache before hitting storage.
 */

import type { Clock } from "../types/index.js";
import { ManagedKey } from "../managed-key.js";

/** Cache hit/miss statistics. */
export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  size: number;
}

/** A pluggable cache of {@link ManagedKey} objects keyed by `keyId`. */
export interface KeyCache {
  /** Return the cached key, or `undefined` on miss/expiry. */
  get(keyId: string): ManagedKey | undefined;
  /** Insert/replace a key, with an optional TTL override (ms). */
  set(keyId: string, key: ManagedKey, ttlMs?: number): void;
  /** Whether a live (non-expired) entry exists. */
  has(keyId: string): boolean;
  /** Remove a single entry; returns whether one was removed. */
  invalidate(keyId: string): boolean;
  /** Remove all entries. */
  clear(): void;
  /** Number of entries currently held. */
  readonly size: number;
  /** Snapshot of cache statistics. */
  stats(): CacheStats;
}

/** Options for {@link InMemoryKeyCache}. */
export interface InMemoryKeyCacheOptions {
  /** Max entries before LRU eviction (default 1000). */
  maxSize?: number;
  /** Default TTL in ms; omit or 0 for no expiry. */
  defaultTtlMs?: number;
  /** Injectable clock for deterministic tests. */
  clock?: Clock;
}

interface CacheEntry {
  key: ManagedKey;
  /** Absolute expiry epoch ms, or `undefined` for no expiry. */
  expiresAt?: number;
}

/**
 * LRU cache with optional per-entry TTL. Expiry is lazy (checked on access) plus
 * an explicit {@link InMemoryKeyCache.sweep}. Uses `Map` insertion order for LRU:
 * on access the entry is re-inserted to mark it most-recently-used.
 *
 * @example
 * ```ts
 * const cache = new InMemoryKeyCache({ maxSize: 500, defaultTtlMs: 60_000 });
 * cache.set(key.keyId, key);
 * const hit = cache.get(key.keyId);
 * ```
 */
export class InMemoryKeyCache implements KeyCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;
  private readonly clock: Clock;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(options: InMemoryKeyCacheOptions = {}) {
    this.maxSize = options.maxSize ?? 1000;
    this.defaultTtlMs = options.defaultTtlMs ?? 0;
    this.clock = options.clock ?? (() => Date.now());
    if (this.maxSize < 1) throw new RangeError("maxSize must be >= 1");
  }

  get(keyId: string): ManagedKey | undefined {
    const entry = this.entries.get(keyId);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (this.isExpired(entry)) {
      this.entries.delete(keyId);
      this.expirations++;
      this.misses++;
      return undefined;
    }
    // Mark most-recently-used.
    this.entries.delete(keyId);
    this.entries.set(keyId, entry);
    this.hits++;
    return entry.key;
  }

  set(keyId: string, key: ManagedKey, ttlMs?: number): void {
    if (this.entries.has(keyId)) this.entries.delete(keyId);
    else if (this.entries.size >= this.maxSize) this.evictOldest();

    const ttl = ttlMs ?? this.defaultTtlMs;
    const entry: CacheEntry = { key };
    if (ttl > 0) entry.expiresAt = this.clock() + ttl;
    this.entries.set(keyId, entry);
  }

  has(keyId: string): boolean {
    const entry = this.entries.get(keyId);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.entries.delete(keyId);
      this.expirations++;
      return false;
    }
    return true;
  }

  invalidate(keyId: string): boolean {
    return this.entries.delete(keyId);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
      size: this.entries.size,
    };
  }

  /** Eagerly remove all expired entries; returns the number removed. */
  sweep(): number {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (this.isExpired(entry)) {
        this.entries.delete(id);
        this.expirations++;
        removed++;
      }
    }
    return removed;
  }

  private isExpired(entry: CacheEntry): boolean {
    return entry.expiresAt !== undefined && this.clock() >= entry.expiresAt;
  }

  private evictOldest(): void {
    const oldest = this.entries.keys().next().value;
    if (oldest !== undefined) {
      this.entries.delete(oldest);
      this.evictions++;
    }
  }
}

/** A no-op cache (every get misses). Useful to disable caching without branching. */
export class NoopKeyCache implements KeyCache {
  readonly size = 0;
  get(_keyId: string): ManagedKey | undefined {
    return undefined;
  }
  set(_keyId: string, _key: ManagedKey, _ttlMs?: number): void {
    /* no-op */
  }
  has(_keyId: string): boolean {
    return false;
  }
  invalidate(_keyId: string): boolean {
    return false;
  }
  clear(): void {
    /* no-op */
  }
  stats(): CacheStats {
    return { hits: 0, misses: 0, evictions: 0, expirations: 0, size: 0 };
  }
}

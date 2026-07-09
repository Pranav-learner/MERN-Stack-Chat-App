import { describe, it, expect } from "vitest";
import { InMemoryKeyCache, NoopKeyCache } from "../src/index.js";
import { makeIdentityKey } from "./helpers.js";

describe("InMemoryKeyCache", () => {
  it("stores and retrieves, tracking hits/misses", () => {
    const cache = new InMemoryKeyCache();
    const key = makeIdentityKey("o", "k1");
    expect(cache.get("k1")).toBeUndefined();
    cache.set("k1", key);
    expect(cache.get("k1")).toBe(key);
    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
  });

  it("invalidates and clears", () => {
    const cache = new InMemoryKeyCache();
    cache.set("k1", makeIdentityKey("o", "k1"));
    expect(cache.invalidate("k1")).toBe(true);
    expect(cache.has("k1")).toBe(false);
    cache.set("k2", makeIdentityKey("o", "k2"));
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("evicts least-recently-used entries beyond maxSize", () => {
    const cache = new InMemoryKeyCache({ maxSize: 2 });
    cache.set("a", makeIdentityKey("o", "a"));
    cache.set("b", makeIdentityKey("o", "b"));
    cache.get("a"); // touch 'a' so 'b' becomes LRU
    cache.set("c", makeIdentityKey("o", "c")); // evicts 'b'
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.stats().evictions).toBe(1);
  });

  it("expires entries by TTL using an injected clock", () => {
    let now = 1000;
    const cache = new InMemoryKeyCache({ clock: () => now, defaultTtlMs: 100 });
    cache.set("k1", makeIdentityKey("o", "k1"));
    now = 1099;
    expect(cache.get("k1")).toBeDefined();
    now = 1100;
    expect(cache.get("k1")).toBeUndefined();
    expect(cache.stats().expirations).toBe(1);
  });

  it("per-entry TTL overrides the default; sweep purges expired", () => {
    let now = 0;
    const cache = new InMemoryKeyCache({ clock: () => now });
    cache.set("a", makeIdentityKey("o", "a"), 50);
    cache.set("b", makeIdentityKey("o", "b"), 200);
    now = 100;
    expect(cache.sweep()).toBe(1);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
  });

  it("rejects maxSize < 1", () => {
    expect(() => new InMemoryKeyCache({ maxSize: 0 })).toThrow(RangeError);
  });
});

describe("NoopKeyCache", () => {
  it("always misses", () => {
    const cache = new NoopKeyCache();
    cache.set("k1", makeIdentityKey("o", "k1"));
    expect(cache.get("k1")).toBeUndefined();
    expect(cache.has("k1")).toBe(false);
    expect(cache.size).toBe(0);
  });
});

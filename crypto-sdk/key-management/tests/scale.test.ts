import { describe, it, expect } from "vitest";
import {
  KeyManager,
  MemoryStorage,
  SecureStorage,
  InMemoryKeyCache,
  KeyType,
} from "../src/index.js";
import { SymmetricKey } from "@securechat/crypto-sdk";
import { counterIdGenerator } from "./helpers.js";

describe("scale — large numbers of keys", () => {
  it("stores, lists, counts, and retrieves 1000 keys", async () => {
    const km = new KeyManager({ idGenerator: counterIdGenerator("s"), cache: new InMemoryKeyCache({ maxSize: 100 }) });
    const N = 1000;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const owner = i % 2 === 0 ? "even" : "odd";
      const key = await km.generateSessionKey({ owner });
      ids.push(key.keyId);
    }

    expect(await km.countKeys()).toBe(N);
    expect(await km.countKeys({ owner: "even" })).toBe(N / 2);
    expect((await km.listKeys({ type: KeyType.SESSION })).length).toBe(N);

    // Retrieve a scattered sample; every one deserializes correctly.
    for (const idx of [0, 1, 250, 499, 500, 999]) {
      const key = await km.getKey(ids[idx]!);
      expect(key.asSymmetricKey().length).toBe(32);
    }

    // Cache is bounded but has evicted, not lost, data.
    expect(km.cache.stats().evictions).toBeGreaterThan(0);
    expect(km.cache.size).toBeLessThanOrEqual(100);
  });

  it("works end-to-end over encrypted-at-rest storage at scale", async () => {
    const master = SymmetricKey.generate();
    const km = new KeyManager({
      idGenerator: counterIdGenerator("e"),
      storage: new SecureStorage(new MemoryStorage(), master),
    });
    const created: string[] = [];
    for (let i = 0; i < 200; i++) {
      created.push((await km.generateIdentityKey({ owner: "u" })).keyId);
    }
    // Bypass the cache to force decryption from secure storage.
    km.cache.clear();
    const key = await km.getKey(created[123]!);
    expect(key.asKeyPair().publicKey.toRaw()).toHaveLength(32);
    expect(await km.countKeys()).toBe(200);
  });
});

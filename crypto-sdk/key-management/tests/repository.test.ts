import { describe, it, expect } from "vitest";
import {
  IdentityKeyRepository,
  SessionKeyRepository,
  InMemoryKeyCache,
  MemoryStorage,
  KeySerializer,
  KeyValidator,
  KeyStatus,
  KeyValidationError,
  DuplicateKeyError,
  KeyNotFoundError,
  systemClock,
  type RepositoryContext,
} from "../src/index.js";
import { makeIdentityKey } from "./helpers.js";

function makeCtx(): RepositoryContext {
  return {
    storage: new MemoryStorage(),
    cache: new InMemoryKeyCache(),
    serializer: new KeySerializer(),
    validator: new KeyValidator(),
    clock: systemClock,
  };
}

describe("BaseKeyRepository (via IdentityKeyRepository)", () => {
  it("saves, finds (cache + storage), and reports existence", async () => {
    const ctx = makeCtx();
    const repo = new IdentityKeyRepository(ctx);
    const key = makeIdentityKey("owner-1", "id_1");
    await repo.save(key);

    // cache hit
    expect((await repo.findById("id_1"))?.keyId).toBe("id_1");
    // storage path (clear cache first)
    ctx.cache.clear();
    const fromStorage = await repo.findById("id_1");
    expect(fromStorage?.asKeyPair().publicKey.toRaw()).toEqual(key.asKeyPair().publicKey.toRaw());
    expect(await repo.exists("id_1")).toBe(true);
    expect(await repo.findById("missing")).toBeNull();
  });

  it("getById throws when missing", async () => {
    const repo = new IdentityKeyRepository(makeCtx());
    await expect(repo.getById("nope")).rejects.toBeInstanceOf(KeyNotFoundError);
  });

  it("rejects duplicates and type mismatches", async () => {
    const ctx = makeCtx();
    const idRepo = new IdentityKeyRepository(ctx);
    const key = makeIdentityKey("o", "id_1");
    await idRepo.save(key);
    await expect(idRepo.save(key)).rejects.toBeInstanceOf(DuplicateKeyError);

    const sessionRepo = new SessionKeyRepository(ctx);
    await expect(sessionRepo.save(key)).rejects.toBeInstanceOf(KeyValidationError); // wrong type
  });

  it("replace updates an existing key and refreshes cache", async () => {
    const ctx = makeCtx();
    const repo = new IdentityKeyRepository(ctx);
    const key = makeIdentityKey("o", "id_1");
    await repo.save(key);
    const updated = key.withMetadata({ status: KeyStatus.INACTIVE });
    await repo.replace(updated);
    expect((await repo.findById("id_1"))?.metadata.status).toBe(KeyStatus.INACTIVE);
  });

  it("lists and counts scoped to the repository's type", async () => {
    const ctx = makeCtx();
    const repo = new IdentityKeyRepository(ctx);
    await repo.save(makeIdentityKey("owner-a", "id_1"));
    await repo.save(
      makeIdentityKey("owner-a", "id_2").withMetadata({ status: KeyStatus.INACTIVE }),
    );
    await repo.save(makeIdentityKey("owner-b", "id_3"));
    expect(await repo.count()).toBe(3);
    expect((await repo.findByOwner("owner-a")).length).toBe(2);
    expect((await repo.findActiveByOwner("owner-a")).length).toBe(1);
  });

  it("delete removes from cache and storage", async () => {
    const ctx = makeCtx();
    const repo = new IdentityKeyRepository(ctx);
    await repo.save(makeIdentityKey("o", "id_1"));
    expect(await repo.delete("id_1")).toBe(true);
    expect(await repo.exists("id_1")).toBe(false);
  });
});

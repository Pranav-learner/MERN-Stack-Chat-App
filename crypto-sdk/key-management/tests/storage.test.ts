import { describe, it, expect } from "vitest";
import { SymmetricKey } from "@securechat/crypto-sdk";
import {
  MemoryStorage,
  SecureStorage,
  DatabaseStorage,
  HardwareStorage,
  CloudKmsStorage,
  DuplicateKeyError,
  KeyNotFoundError,
  StorageFailureError,
  KeyStatus,
  KeyType,
  type StoredRecord,
} from "../src/index.js";

function record(overrides: Partial<StoredRecord> = {}): StoredRecord {
  return {
    keyId: "k1",
    type: KeyType.SESSION,
    owner: "o1",
    status: KeyStatus.ACTIVE,
    version: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    payload: JSON.stringify({ secret: "payload-data" }),
    encrypted: false,
    ...overrides,
  };
}

describe("MemoryStorage", () => {
  it("set/get/has/delete round-trip", async () => {
    const s = new MemoryStorage();
    await s.set(record());
    expect(await s.has("k1")).toBe(true);
    expect((await s.get("k1"))?.payload).toContain("payload-data");
    expect(await s.delete("k1")).toBe(true);
    expect(await s.get("k1")).toBeNull();
  });

  it("rejects duplicate ids and missing updates", async () => {
    const s = new MemoryStorage();
    await s.set(record());
    await expect(s.set(record())).rejects.toBeInstanceOf(DuplicateKeyError);
    await expect(s.update(record({ keyId: "ghost" }))).rejects.toBeInstanceOf(KeyNotFoundError);
  });

  it("isolates stored records from external mutation", async () => {
    const s = new MemoryStorage();
    const r = record();
    await s.set(r);
    r.owner = "mutated";
    expect((await s.get("k1"))?.owner).toBe("o1");
    const fetched = (await s.get("k1"))!;
    fetched.owner = "mutated-again";
    expect((await s.get("k1"))?.owner).toBe("o1");
  });

  it("filters list/count by owner/type/status", async () => {
    const s = new MemoryStorage();
    await s.set(record({ keyId: "a", owner: "x", type: KeyType.SESSION }));
    await s.set(record({ keyId: "b", owner: "x", type: KeyType.IDENTITY }));
    await s.set(record({ keyId: "c", owner: "y", type: KeyType.SESSION }));
    expect(await s.count()).toBe(3);
    expect(await s.count({ owner: "x" })).toBe(2);
    expect(await s.count({ type: KeyType.SESSION })).toBe(2);
    expect((await s.list({ owner: "x", type: KeyType.IDENTITY })).map((r) => r.keyId)).toEqual([
      "b",
    ]);
  });
});

describe("SecureStorage", () => {
  const master = SymmetricKey.generate();

  it("encrypts payload at rest but keeps it transparent to callers", async () => {
    const inner = new MemoryStorage();
    const secure = new SecureStorage(inner, master);
    await secure.set(record());

    // Inner storage holds an ENCRYPTED payload...
    const raw = await inner.get("k1");
    expect(raw?.encrypted).toBe(true);
    expect(raw?.payload).not.toContain("payload-data");

    // ...but the decorator returns the decrypted payload.
    const open = await secure.get("k1");
    expect(open?.encrypted).toBe(false);
    expect(open?.payload).toContain("payload-data");
  });

  it("list() decrypts each record", async () => {
    const secure = new SecureStorage(new MemoryStorage(), master);
    await secure.set(record({ keyId: "a" }));
    await secure.set(record({ keyId: "b" }));
    const all = await secure.list();
    expect(all.every((r) => r.payload.includes("payload-data"))).toBe(true);
  });

  it("fails to decrypt with the wrong master key (tamper/rotation detection)", async () => {
    const inner = new MemoryStorage();
    await new SecureStorage(inner, master).set(record());
    const wrong = new SecureStorage(inner, SymmetricKey.generate());
    await expect(wrong.get("k1")).rejects.toBeInstanceOf(StorageFailureError);
  });
});

describe("placeholder storages", () => {
  it("report unavailable and throw StorageFailureError on every op", async () => {
    for (const s of [new DatabaseStorage(), new HardwareStorage(), new CloudKmsStorage()]) {
      expect(s.available).toBe(false);
      await expect(s.get("x")).rejects.toBeInstanceOf(StorageFailureError);
      await expect(s.set(record())).rejects.toBeInstanceOf(StorageFailureError);
      await expect(s.list()).rejects.toBeInstanceOf(StorageFailureError);
    }
  });
});

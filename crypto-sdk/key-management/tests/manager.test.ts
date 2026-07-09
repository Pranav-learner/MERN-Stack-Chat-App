import { describe, it, expect } from "vitest";
import { SharedSecret, randomBytes, sign, verify } from "@securechat/crypto-sdk";
import {
  KeyManager,
  KeyMaterialKind,
  KeyPurpose,
  KeyStatus,
  KeyType,
  AgeBasedRotationPolicy,
  NoopRecoveryProvider,
  RecoveryError,
  DuplicateKeyError,
  KeyNotFoundError,
  ExportError,
  ImportError,
  toIso,
  type SerializedKey,
} from "../src/index.js";
import { counterIdGenerator, testManager } from "./helpers.js";

describe("KeyManager — generation", () => {
  it("generates identity (Ed25519), session (AES), and agreement (X25519) keys", async () => {
    const km = testManager();
    const id = await km.generateIdentityKey({ owner: "u" });
    const session = await km.generateSessionKey({ owner: "u" });
    const prekey = await km.generateAgreementKey({ owner: "u" });

    expect(id.metadata.type).toBe(KeyType.IDENTITY);
    expect(id.metadata.algorithm).toBe("ed25519");
    expect(id.metadata.purpose).toBe(KeyPurpose.SIGNING);
    expect(session.metadata.algorithm).toBe("AES-256-GCM");
    expect(prekey.metadata.algorithm).toBe("x25519");
    expect(prekey.metadata.type).toBe(KeyType.PREKEY);

    // The generated identity key actually works with the SDK.
    const sig = sign(id.asKeyPair().privateKey, "hello");
    expect(verify(id.asKeyPair().publicKey, "hello", sig)).toBe(true);
  });

  it("stores shared secrets and raw keys", async () => {
    const km = testManager();
    const secret = await km.storeSharedSecret(SharedSecret.fromBytes(randomBytes(32)), { owner: "u" });
    expect(secret.metadata.type).toBe(KeyType.SHARED_SECRET);
    const raw = await km.storeRawKey(randomBytes(48), {
      owner: "u",
      algorithm: "custom",
      purpose: KeyPurpose.ENCRYPTION,
      type: KeyType.GROUP,
    });
    expect(raw.asRawBytes()).toHaveLength(48);
  });

  it("honors explicit keyId, label, custom, and expiry", async () => {
    const km = testManager();
    const key = await km.generateSessionKey({
      owner: "u",
      keyId: "custom-id",
      label: "my key",
      custom: { tenant: "acme" },
      expiresAt: toIso(9_999_999_999_000),
    });
    expect(key.keyId).toBe("custom-id");
    expect(key.metadata.label).toBe("my key");
    expect(key.metadata.custom).toEqual({ tenant: "acme" });
    expect(key.metadata.expiresAt).toBeDefined();
  });
});

describe("KeyManager — retrieval & cache", () => {
  it("retrieves via cache then storage; getKey throws when missing", async () => {
    const km = testManager();
    const key = await km.generateSessionKey({ owner: "u" });
    expect((await km.getKey(key.keyId)).keyId).toBe(key.keyId);
    expect(km.cache.stats().hits).toBeGreaterThanOrEqual(1);

    km.cache.clear();
    expect((await km.getKey(key.keyId)).keyId).toBe(key.keyId); // from storage
    await expect(km.getKey("nope")).rejects.toBeInstanceOf(KeyNotFoundError);
  });

  it("rejects duplicate store", async () => {
    const km = testManager();
    const key = await km.generateSessionKey({ owner: "u", keyId: "dup" });
    await expect(km.storeKey(key)).rejects.toBeInstanceOf(DuplicateKeyError);
  });
});

describe("KeyManager — import / export", () => {
  it("exports public-only by default and imports into a fresh manager", async () => {
    const source = testManager();
    const id = await source.generateIdentityKey({ owner: "u" });

    const publicJson = (await source.exportKey(id.keyId)) as string;
    const parsed = JSON.parse(publicJson) as SerializedKey;
    expect(parsed.material.kind).toBe("public"); // private stripped

    const target = testManager();
    const imported = await target.importKey(publicJson);
    expect(imported.hasPrivateMaterial()).toBe(false);
    expect(imported.asPublicKey().toRaw()).toEqual(id.asKeyPair().publicKey.toRaw());
  });

  it("round-trips full keys through json, base64, and binary", async () => {
    const source = testManager();
    const key = await source.generateSessionKey({ owner: "u" });

    for (const encoding of ["json", "base64", "binary"] as const) {
      const exported = await source.exportKey(key.keyId, { includePrivate: true, encoding });
      const target = testManager();
      const imported = await target.importKey(exported as string | Uint8Array);
      expect(imported.asSymmetricKey().bytes).toEqual(key.asSymmetricKey().bytes);
    }
  });

  it("refuses public-only export of secret-only material", async () => {
    const km = testManager();
    const session = await km.generateSessionKey({ owner: "u" });
    await expect(km.exportKey(session.keyId, { includePrivate: false })).rejects.toBeInstanceOf(ExportError);
  });

  it("rejects corrupted import data", async () => {
    const km = testManager();
    await expect(km.importKey("{ not valid")).rejects.toBeInstanceOf(ImportError);
  });

  it("overwrite replaces an existing key", async () => {
    const km = testManager();
    const key = await km.generateSessionKey({ owner: "u", keyId: "k" });
    const exported = (await km.exportKey(key.keyId, { includePrivate: true })) as string;
    // Without overwrite -> duplicate.
    await expect(km.importKey(exported)).rejects.toBeInstanceOf(DuplicateKeyError);
    // With overwrite -> ok.
    const again = await km.importKey(exported, { overwrite: true });
    expect(again.keyId).toBe("k");
  });
});

describe("KeyManager — lifecycle status & validation", () => {
  it("expires and sets status (metadata only)", async () => {
    // Controlled clock so updatedAt deterministically advances past createdAt.
    let t = 1_000;
    const km = new KeyManager({ idGenerator: counterIdGenerator(), clock: () => t });
    const key = await km.generateSessionKey({ owner: "u" });
    t = 5_000;
    const expired = await km.expireKey(key.keyId);
    expect(expired.metadata.status).toBe(KeyStatus.EXPIRED);
    expect(expired.metadata.updatedAt).not.toBe(key.metadata.createdAt);
    expect(expired.metadata.createdAt).toBe(key.metadata.createdAt); // unchanged

    const revoked = await km.setStatus(key.keyId, KeyStatus.REVOKED);
    expect(revoked.metadata.status).toBe(KeyStatus.REVOKED);
  });

  it("validateKey enforces expiry", async () => {
    const km = testManager();
    const key = await km.generateSessionKey({ owner: "u", expiresAt: toIso(1000) });
    await expect(km.validateKey(key.keyId, { now: 2000 })).rejects.toThrowError();
    await expect(km.validateKey(key.keyId, { checkExpiry: false })).resolves.toBeUndefined();
  });

  it("deleteKey removes the key", async () => {
    const km = testManager();
    const key = await km.generateSessionKey({ owner: "u" });
    expect(await km.deleteKey(key.keyId)).toBe(true);
    expect(await km.hasKey(key.keyId)).toBe(false);
  });
});

describe("KeyManager — rotation & history", () => {
  it("rotates a key producing a linked new version and retiring the old", async () => {
    const km = testManager();
    const v1 = await km.generateIdentityKey({ owner: "u", label: "identity" });
    const { previous, current } = await km.rotateKey(v1.keyId);

    expect(current.metadata.version).toBe(2);
    expect(current.metadata.rotationCount).toBe(1);
    expect(current.metadata.previousKeyId).toBe(v1.keyId);
    expect(current.metadata.status).toBe(KeyStatus.ACTIVE);
    expect(current.metadata.label).toBe("identity"); // carried forward
    expect(current.keyId).not.toBe(v1.keyId);

    expect(previous.metadata.status).toBe(KeyStatus.ROTATED);
    expect((await km.getKey(v1.keyId)).metadata.status).toBe(KeyStatus.ROTATED);

    // New key material is genuinely different.
    expect(current.asKeyPair().publicKey.toRaw()).not.toEqual(v1.asKeyPair().publicKey.toRaw());
  });

  it("supports a custom material generator", async () => {
    const km = testManager();
    const secret = await km.storeSharedSecret(SharedSecret.fromBytes(randomBytes(32)), { owner: "u" });
    // Shared secrets have no default generator -> must supply one.
    await expect(km.rotateKey(secret.keyId)).rejects.toThrowError();
    const { current } = await km.rotateKey(secret.keyId, {
      generator: () => ({
        kind: KeyMaterialKind.SHARED_SECRET,
        sharedSecret: SharedSecret.fromBytes(randomBytes(32)),
      }),
    });
    expect(current.metadata.version).toBe(2);
  });

  it("reconstructs rotation history oldest-first", async () => {
    const km = testManager();
    const v1 = await km.generateIdentityKey({ owner: "u" });
    const r1 = await km.rotateKey(v1.keyId);
    const r2 = await km.rotateKey(r1.current.keyId);
    const history = await km.getHistory(r2.current.keyId);
    expect(history.map((h) => h.version)).toEqual([1, 2, 3]);
  });

  it("evaluates a rotation policy without rotating", async () => {
    const km = testManager();
    const old = await km.generateSessionKey({ owner: "u" });
    await km.replaceKey(old.withMetadata({ createdAt: toIso(0) }));
    const decisions = await km.evaluateRotation(new AgeBasedRotationPolicy(1000), undefined, { now: 10_000 });
    expect(decisions.find((d) => d.keyId === old.keyId)?.shouldRotate).toBe(true);
    // still present & not rotated
    expect((await km.getKey(old.keyId)).metadata.status).toBe(KeyStatus.ACTIVE);
  });
});

describe("KeyManager — recovery hook", () => {
  it("delegates to the recovery provider (noop throws)", async () => {
    const km = new KeyManager({ recoveryProvider: new NoopRecoveryProvider() });
    const key = await km.generateSessionKey({ owner: "u" });
    await expect(km.recoverKey(key.keyId)).rejects.toBeInstanceOf(RecoveryError);
    await expect(km.backupKey(key.keyId)).rejects.toBeInstanceOf(RecoveryError);
  });
});

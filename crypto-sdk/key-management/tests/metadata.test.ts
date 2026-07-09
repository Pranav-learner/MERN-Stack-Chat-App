import { describe, it, expect } from "vitest";
import { generateSigningKeyPair, SymmetricKey } from "@securechat/crypto-sdk";
import {
  KeyMaterialKind,
  KeyPurpose,
  KeyStatus,
  KeyType,
  computeFingerprint,
  createIdGenerator,
  createKeyMetadata,
  isExpired,
  timeToExpiry,
  toIso,
  touchMetadata,
} from "../src/index.js";

describe("metadata", () => {
  const ctx = { clock: () => 1_700_000_000_000, idGenerator: createIdGenerator("id") };

  it("creates a complete metadata record with defaults", () => {
    const meta = createKeyMetadata(
      {
        type: KeyType.IDENTITY,
        algorithm: "ed25519",
        purpose: KeyPurpose.SIGNING,
        owner: "user-1",
        fingerprint: "abc",
      },
      ctx,
    );
    expect(meta.version).toBe(1);
    expect(meta.rotationCount).toBe(0);
    expect(meta.status).toBe(KeyStatus.ACTIVE);
    expect(meta.keyId).toMatch(/^id_/);
    expect(meta.createdAt).toBe(meta.updatedAt);
    expect(meta.sdkVersion).toBeTruthy();
  });

  it("fingerprints public material of a key pair (stable, hex sha-256)", () => {
    const kp = generateSigningKeyPair();
    const fp1 = computeFingerprint({ kind: KeyMaterialKind.KEYPAIR, keyPair: kp });
    const fp2 = computeFingerprint({ kind: KeyMaterialKind.PUBLIC, publicKey: kp.publicKey });
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
    expect(fp1).toBe(fp2); // keypair fingerprint == its public key fingerprint
  });

  it("different symmetric keys fingerprint differently", () => {
    const a = computeFingerprint({
      kind: KeyMaterialKind.SYMMETRIC,
      symmetricKey: SymmetricKey.generate(),
    });
    const b = computeFingerprint({
      kind: KeyMaterialKind.SYMMETRIC,
      symmetricKey: SymmetricKey.generate(),
    });
    expect(a).not.toBe(b);
  });

  it("touchMetadata updates only updatedAt", () => {
    const meta = createKeyMetadata(
      {
        type: KeyType.SESSION,
        algorithm: "AES-256-GCM",
        purpose: KeyPurpose.ENCRYPTION,
        owner: "u",
        fingerprint: "f",
      },
      ctx,
    );
    const later = touchMetadata(meta, () => 1_700_000_100_000);
    expect(later.createdAt).toBe(meta.createdAt);
    expect(later.updatedAt).not.toBe(meta.updatedAt);
  });

  it("expiry helpers", () => {
    const base = createKeyMetadata(
      {
        type: KeyType.SESSION,
        algorithm: "AES-256-GCM",
        purpose: KeyPurpose.ENCRYPTION,
        owner: "u",
        fingerprint: "f",
        expiresAt: toIso(1_700_000_050_000),
      },
      ctx,
    );
    expect(isExpired(base, 1_700_000_049_000)).toBe(false);
    expect(isExpired(base, 1_700_000_051_000)).toBe(true);
    expect(timeToExpiry(base, 1_700_000_040_000)).toBe(10_000);
    // no expiry -> never expires
    const noExpiry = { ...base, expiresAt: undefined };
    expect(isExpired(noExpiry, Date.now())).toBe(false);
    expect(timeToExpiry(noExpiry)).toBe(Infinity);
  });
});

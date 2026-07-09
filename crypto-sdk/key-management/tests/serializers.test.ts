import { describe, it, expect } from "vitest";
import { generateKeyPair, SharedSecret, SymmetricKey, randomBytes } from "@securechat/crypto-sdk";
import {
  KeyMaterialKind,
  KeyManager,
  KeyPurpose,
  KeyType,
  KeySerializer,
  SerializationError,
  UnsupportedVersionError,
  ManagedKey,
  computeFingerprint,
  createKeyMetadata,
  systemClock,
  type SerializedKey,
} from "../src/index.js";
import { makeIdentityKey } from "./helpers.js";

const serializer = new KeySerializer();

function makeKey(kind: "symmetric" | "keypair" | "shared" | "raw"): ManagedKey {
  const idGen = () => `key_${kind}`;
  if (kind === "symmetric") {
    const symmetricKey = SymmetricKey.generate();
    const material = { kind: KeyMaterialKind.SYMMETRIC as const, symmetricKey };
    const metadata = createKeyMetadata(
      {
        type: KeyType.SESSION,
        algorithm: "AES-256-GCM",
        purpose: KeyPurpose.ENCRYPTION,
        owner: "o",
        fingerprint: computeFingerprint(material),
      },
      { clock: systemClock, idGenerator: idGen },
    );
    return new ManagedKey({ metadata, material });
  }
  if (kind === "keypair") return makeIdentityKey("o", "key_keypair");
  if (kind === "shared") {
    const sharedSecret = SharedSecret.fromBytes(randomBytes(32));
    const material = { kind: KeyMaterialKind.SHARED_SECRET as const, sharedSecret };
    const metadata = createKeyMetadata(
      {
        type: KeyType.SHARED_SECRET,
        algorithm: "shared-secret",
        purpose: KeyPurpose.DERIVATION,
        owner: "o",
        fingerprint: computeFingerprint(material),
      },
      { clock: systemClock, idGenerator: idGen },
    );
    return new ManagedKey({ metadata, material });
  }
  const bytes = randomBytes(48);
  const material = { kind: KeyMaterialKind.RAW as const, bytes };
  const metadata = createKeyMetadata(
    {
      type: KeyType.GROUP,
      algorithm: "raw",
      purpose: KeyPurpose.ENCRYPTION,
      owner: "o",
      fingerprint: computeFingerprint(material),
    },
    { clock: systemClock, idGenerator: idGen },
  );
  return new ManagedKey({ metadata, material });
}

describe("serializers", () => {
  it("round-trips every material kind through structured form", () => {
    for (const kind of ["symmetric", "keypair", "shared", "raw"] as const) {
      const key = makeKey(kind);
      const back = serializer.deserialize(serializer.serialize(key));
      expect(back.keyId).toBe(key.keyId);
      expect(back.metadata).toEqual(key.metadata);
      expect(back.materialKind).toBe(key.materialKind);
    }
  });

  it("round-trips a key pair preserving public + private material", () => {
    const key = makeKey("keypair");
    const back = serializer.fromJSON(serializer.toJSON(key));
    expect(back.asKeyPair().publicKey.toRaw()).toEqual(key.asKeyPair().publicKey.toRaw());
    // private key survived (can derive the same public key)
    expect(back.asKeyPair().privateKey.toPublicKey().toRaw()).toEqual(
      key.asKeyPair().publicKey.toRaw(),
    );
  });

  it("round-trips through JSON, base64, and binary", () => {
    const key = makeKey("symmetric");
    expect(serializer.fromJSON(serializer.toJSON(key)).metadata).toEqual(key.metadata);
    expect(serializer.fromBase64(serializer.toBase64(key)).metadata).toEqual(key.metadata);
    expect(serializer.fromBinary(serializer.toBinary(key)).metadata).toEqual(key.metadata);
  });

  it("embeds a versioned, integrity-checked envelope", () => {
    const serialized = serializer.serialize(makeKey("raw"));
    expect(serialized.format).toBe("securechat-kms-key");
    expect(serialized.formatVersion).toBe(1);
    expect(serialized.integrity.algorithm).toBe("sha256");
    expect(serialized.integrity.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects a tampered metadata field (integrity failure)", () => {
    const serialized = serializer.serialize(makeKey("symmetric"));
    const tampered: SerializedKey = {
      ...serialized,
      metadata: { ...serialized.metadata, owner: "attacker" },
    };
    expect(() => serializer.deserialize(tampered)).toThrow(SerializationError);
  });

  it("detects tampered material bytes (integrity failure)", () => {
    const serialized = serializer.serialize(makeKey("raw"));
    const material = serialized.material as { kind: "raw"; bytes: string };
    const flipped = "A" + material.bytes.slice(1);
    const tampered: SerializedKey = { ...serialized, material: { ...material, bytes: flipped } };
    expect(() => serializer.deserialize(tampered)).toThrow(SerializationError);
  });

  it("detects a forged integrity value", () => {
    const serialized = serializer.serialize(makeKey("keypair"));
    const tampered: SerializedKey = {
      ...serialized,
      integrity: { algorithm: "sha256", value: "0".repeat(64) },
    };
    expect(() => serializer.deserialize(tampered)).toThrow(SerializationError);
  });

  it("rejects an unknown format tag", () => {
    const serialized = serializer.serialize(makeKey("raw"));
    expect(() =>
      serializer.deserialize({ ...serialized, format: "bogus" } as unknown as SerializedKey),
    ).toThrow(SerializationError);
  });

  it("rejects an unsupported (unmigratable) version", () => {
    const serialized = serializer.serialize(makeKey("raw"));
    expect(() => serializer.deserialize({ ...serialized, formatVersion: 99 })).toThrow(
      UnsupportedVersionError,
    );
  });

  it("rejects invalid JSON", () => {
    expect(() => serializer.fromJSON("not json")).toThrow(SerializationError);
  });

  it("interops with the KeyManager export/import path", async () => {
    const km = new KeyManager();
    const key = await km.generateSessionKey({ owner: "u" });
    const exported = (await km.exportKey(key.keyId, {
      includePrivate: true,
      encoding: "json",
    })) as string;
    const parsed = serializer.fromJSON(exported);
    expect(parsed.asSymmetricKey().bytes).toEqual(key.asSymmetricKey().bytes);
  });
});

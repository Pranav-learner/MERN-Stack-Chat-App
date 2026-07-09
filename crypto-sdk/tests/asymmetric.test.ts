import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  deriveSharedSecret,
  KeyPair,
  PublicKey,
  PrivateKey,
  SharedSecret,
  AsymmetricAlgorithm,
  KeyFormat,
  InvalidKeyError,
  encrypt,
  decrypt,
  bytesToUtf8,
} from "../src/index.js";

describe("asymmetric (X25519 key agreement)", () => {
  it("generates an X25519 key pair", () => {
    const kp = generateKeyPair();
    expect(kp).toBeInstanceOf(KeyPair);
    expect(kp.algorithm).toBe(AsymmetricAlgorithm.X25519);
    expect(kp.publicKey.toRaw()).toHaveLength(32);
  });

  it("two parties derive the SAME shared secret (ECDH symmetry)", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const sA = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const sB = deriveSharedSecret(bob.privateKey, alice.publicKey);
    expect(sA.bytes).toEqual(sB.bytes);
    expect(sA).toBeInstanceOf(SharedSecret);
  });

  it("different pairs derive DIFFERENT secrets", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const eve = generateKeyPair();
    const good = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const bad = deriveSharedSecret(alice.privateKey, eve.publicKey);
    expect(good.bytes).not.toEqual(bad.bytes);
  });

  it("derived keys enable end-to-end symmetric encryption", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const keyA = deriveSharedSecret(alice.privateKey, bob.publicKey).deriveKey({ info: "e2e:v1" });
    const keyB = deriveSharedSecret(bob.privateKey, alice.publicKey).deriveKey({ info: "e2e:v1" });
    const payload = encrypt(keyA, "hi bob");
    expect(bytesToUtf8(decrypt(keyB, payload))).toBe("hi bob");
  });

  it("HKDF info separation yields independent keys", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const secret = deriveSharedSecret(alice.privateKey, bob.publicKey);
    expect(secret.deriveKey({ info: "a" }).bytes).not.toEqual(
      secret.deriveKey({ info: "b" }).bytes,
    );
  });

  describe("key import/export round-trips", () => {
    const kp = generateKeyPair();

    it("public: RAW / DER / PEM / JWK", () => {
      const alg = AsymmetricAlgorithm.X25519;
      expect(PublicKey.fromRaw(kp.publicKey.toRaw(), alg).toRaw()).toEqual(kp.publicKey.toRaw());
      expect(PublicKey.fromBase64(kp.publicKey.toBase64(), alg).equals(kp.publicKey)).toBe(true);
      expect(PublicKey.fromDER(kp.publicKey.toDER(), alg).toRaw()).toEqual(kp.publicKey.toRaw());
      expect(PublicKey.fromPEM(kp.publicKey.toPEM(), alg).toRaw()).toEqual(kp.publicKey.toRaw());
      expect(PublicKey.fromJWK(kp.publicKey.toJWK(), alg).toRaw()).toEqual(kp.publicKey.toRaw());
    });

    it("private: DER / PEM / JWK reconstruct the same public key", () => {
      const alg = AsymmetricAlgorithm.X25519;
      const expected = kp.publicKey.toRaw();
      expect(PrivateKey.fromDER(kp.privateKey.toDER(), alg).toPublicKey().toRaw()).toEqual(
        expected,
      );
      expect(PrivateKey.fromPEM(kp.privateKey.toPEM(), alg).toPublicKey().toRaw()).toEqual(
        expected,
      );
      expect(PrivateKey.fromJWK(kp.privateKey.toJWK(), alg).toPublicKey().toRaw()).toEqual(
        expected,
      );
    });

    it("generic export() dispatches on KeyFormat", () => {
      expect(kp.publicKey.export(KeyFormat.RAW)).toBeInstanceOf(Uint8Array);
      expect(typeof kp.publicKey.export(KeyFormat.PEM)).toBe("string");
      expect(kp.privateKey.export(KeyFormat.DER)).toBeInstanceOf(Uint8Array);
    });

    it("PublicKey.equals distinguishes different keys", () => {
      expect(kp.publicKey.equals(generateKeyPair().publicKey)).toBe(false);
    });
  });

  describe("validation", () => {
    it("rejects agreement with an Ed25519 key", () => {
      const signing = generateKeyPair(AsymmetricAlgorithm.ED25519);
      const x = generateKeyPair();
      expect(() => deriveSharedSecret(signing.privateKey, x.publicKey)).toThrow(InvalidKeyError);
      expect(() => deriveSharedSecret(x.privateKey, signing.publicKey)).toThrow(InvalidKeyError);
    });

    it("rejects importing a malformed raw public key", () => {
      expect(() => PublicKey.fromRaw(new Uint8Array(10), AsymmetricAlgorithm.X25519)).toThrow();
    });

    it("rejects a public/private algorithm mismatch in KeyPair", () => {
      const x = generateKeyPair();
      const ed = generateKeyPair(AsymmetricAlgorithm.ED25519);
      expect(() => new KeyPair(x.publicKey, ed.privateKey)).toThrow(InvalidKeyError);
    });
  });
});

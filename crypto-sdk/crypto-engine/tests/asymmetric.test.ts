import { describe, it, expect } from "vitest";
import {
  AsymmetricAlgorithm,
  PublicKey,
  bytesToUtf8,
  generateKeyPair,
} from "@securechat/crypto-sdk";
import {
  AsymmetricEngine,
  fingerprint,
  fingerprintSegments,
  isX25519SmallOrderPoint,
  PublicKeyValidationError,
  SymmetricEngine,
} from "../src/index.js";

const engine = new AsymmetricEngine();

describe("AsymmetricEngine", () => {
  it("agrees to the same shared secret on both sides", () => {
    const alice = engine.generateKeyAgreementKeyPair();
    const bob = engine.generateKeyAgreementKeyPair();
    const sA = engine.agree(alice.privateKey, bob.publicKey);
    const sB = engine.agree(bob.privateKey, alice.publicKey);
    expect(sA.bytes).toEqual(sB.bytes);
  });

  it("derived keys enable end-to-end symmetric encryption", () => {
    const alice = engine.generateKeyAgreementKeyPair();
    const bob = engine.generateKeyAgreementKeyPair();
    const keyA = engine.agree(alice.privateKey, bob.publicKey).deriveKey({ info: "e2e" });
    const keyB = engine.agree(bob.privateKey, alice.publicKey).deriveKey({ info: "e2e" });
    const payload = new SymmetricEngine(keyA).encrypt("hi bob");
    expect(bytesToUtf8(new SymmetricEngine(keyB).decrypt(payload))).toBe("hi bob");
  });

  it("validates well-formed public keys", () => {
    const kp = engine.generateKeyAgreementKeyPair();
    expect(() => engine.validatePublicKey(kp.publicKey)).not.toThrow();
  });

  it("rejects X25519 small-order points on validate and agree", () => {
    const zero = PublicKey.fromRaw(new Uint8Array(32), AsymmetricAlgorithm.X25519);
    expect(isX25519SmallOrderPoint(new Uint8Array(32))).toBe(true);
    expect(() => engine.validatePublicKey(zero)).toThrow(PublicKeyValidationError);
    const alice = engine.generateKeyAgreementKeyPair();
    expect(() => engine.agree(alice.privateKey, zero)).toThrow(PublicKeyValidationError);
  });

  it("does not flag a legitimate public key as small-order", () => {
    const kp = engine.generateKeyAgreementKeyPair();
    expect(isX25519SmallOrderPoint(kp.publicKey.toRaw())).toBe(false);
  });

  it("importValidatedPublicKey imports and validates raw bytes", () => {
    const kp = engine.generateKeyAgreementKeyPair();
    const imported = engine.importValidatedPublicKey(kp.publicKey.toRaw(), AsymmetricAlgorithm.X25519);
    expect(imported.equals(kp.publicKey)).toBe(true);
    expect(() => engine.importValidatedPublicKey(new Uint8Array(32), AsymmetricAlgorithm.X25519)).toThrow(
      PublicKeyValidationError,
    );
  });

  it("fingerprints keys (hex, base64, segments) deterministically", () => {
    const kp = generateKeyPair();
    expect(fingerprint(kp.publicKey)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint(kp.publicKey)).toBe(fingerprint(kp.publicKey));
    expect(fingerprint(kp.publicKey, { encoding: "base64" })).not.toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintSegments(kp.publicKey)).toContain(" ");
    // distinct keys -> distinct fingerprints
    expect(fingerprint(kp.publicKey)).not.toBe(fingerprint(generateKeyPair().publicKey));
  });

  it("compares public keys in constant time", () => {
    const kp = engine.generateKeyAgreementKeyPair();
    expect(engine.comparePublicKeys(kp.publicKey, kp.publicKey)).toBe(true);
    expect(engine.comparePublicKeys(kp.publicKey, engine.generateKeyAgreementKeyPair().publicKey)).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  generateSigningKeyPair,
  generateKeyPair,
  sign,
  verify,
  Signature,
  AsymmetricAlgorithm,
  InvalidKeyError,
  randomBytes,
  utf8ToBytes,
} from "../src/index.js";

describe("signatures (Ed25519)", () => {
  it("generates an Ed25519 key pair", () => {
    const kp = generateSigningKeyPair();
    expect(kp.algorithm).toBe(AsymmetricAlgorithm.ED25519);
  });

  it("signs and verifies a message", () => {
    const kp = generateSigningKeyPair();
    const sig = sign(kp.privateKey, "hello");
    expect(sig).toBeInstanceOf(Signature);
    expect(sig.length).toBe(64);
    expect(sig.isEd25519Length).toBe(true);
    expect(verify(kp.publicKey, "hello", sig)).toBe(true);
  });

  it("signs binary and string forms equivalently", () => {
    const kp = generateSigningKeyPair();
    const sig = sign(kp.privateKey, utf8ToBytes("hi"));
    expect(verify(kp.publicKey, "hi", sig)).toBe(true);
  });

  it("verify returns FALSE for a tampered message", () => {
    const kp = generateSigningKeyPair();
    const sig = sign(kp.privateKey, "hello");
    expect(verify(kp.publicKey, "hellp", sig)).toBe(false);
  });

  it("verify returns FALSE with the WRONG public key", () => {
    const kp = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const sig = sign(kp.privateKey, "hello");
    expect(verify(other.publicKey, "hello", sig)).toBe(false);
  });

  it("verify returns FALSE for a tampered signature", () => {
    const kp = generateSigningKeyPair();
    const sig = sign(kp.privateKey, "hello");
    const bytes = sig.bytes;
    bytes[0] ^= 0xff;
    expect(verify(kp.publicKey, "hello", Signature.fromBytes(bytes))).toBe(false);
  });

  it("verify returns FALSE for a wrong-length signature (no throw)", () => {
    const kp = generateSigningKeyPair();
    expect(verify(kp.publicKey, "hello", Signature.fromBytes(randomBytes(10)))).toBe(false);
  });

  it("Signature serializes to/from base64 and hex", () => {
    const kp = generateSigningKeyPair();
    const sig = sign(kp.privateKey, "data");
    expect(Signature.fromBase64(sig.toBase64()).bytes).toEqual(sig.bytes);
    expect(Signature.fromHex(sig.toHex()).bytes).toEqual(sig.bytes);
  });

  it("rejects signing with a non-Ed25519 key", () => {
    const x = generateKeyPair(AsymmetricAlgorithm.X25519);
    expect(() => sign(x.privateKey, "x")).toThrow(InvalidKeyError);
  });

  it("rejects verifying with a non-Ed25519 key", () => {
    const kp = generateSigningKeyPair();
    const x = generateKeyPair(AsymmetricAlgorithm.X25519);
    const sig = sign(kp.privateKey, "x");
    expect(() => verify(x.publicKey, "x", sig)).toThrow(InvalidKeyError);
  });
});

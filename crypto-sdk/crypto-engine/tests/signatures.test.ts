import { describe, it, expect } from "vitest";
import { generateSigningKeyPair, generateKeyPair, randomBytes } from "@securechat/crypto-sdk";
import { SignatureEngine, SignedPayload } from "../src/index.js";

const engine = new SignatureEngine({ clock: () => 1_700_000_000_000 });

describe("SignatureEngine", () => {
  it("signs and verifies raw messages", () => {
    const kp = generateSigningKeyPair();
    const sig = engine.sign(kp.privateKey, "hello");
    expect(engine.verify(kp.publicKey, "hello", sig)).toBe(true);
    expect(engine.verify(kp.publicKey, "hellp", sig)).toBe(false);
  });

  it("produces attached SignedPayloads with metadata", () => {
    const kp = generateSigningKeyPair();
    const signed = engine.signPayload(kp.privateKey, "contract v1");
    expect(signed.isDetached).toBe(false);
    expect(signed.metadata.algorithm).toBe("ed25519");
    expect(signed.metadata.signerFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.metadata.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(engine.verifyPayload(kp.publicKey, signed)).toBe(true);
  });

  it("produces and verifies detached signatures", () => {
    const kp = generateSigningKeyPair();
    const data = randomBytes(500);
    const detached = engine.signDetached(kp.privateKey, data);
    expect(detached.isDetached).toBe(true);
    expect(engine.verifyPayload(kp.publicKey, detached, data)).toBe(true);
    // detached requires a message
    expect(engine.verifyPayload(kp.publicKey, detached)).toBe(false);
    // wrong message fails
    expect(engine.verifyPayload(kp.publicKey, detached, randomBytes(500))).toBe(false);
  });

  it("detects a tampered attached payload", () => {
    const kp = generateSigningKeyPair();
    const signed = engine.signPayload(kp.privateKey, "original");
    // Rebuild with a mismatching attached payload but the original signature.
    const forged = new SignedPayload(
      signed.signature,
      signed.metadata,
      new TextEncoder().encode("modified"),
    );
    expect(engine.verifyPayload(kp.publicKey, forged)).toBe(false);
  });

  it("detects a mismatched explicit message against an attached payload", () => {
    const kp = generateSigningKeyPair();
    const signed = engine.signPayload(kp.privateKey, "attached");
    expect(engine.verifyPayload(kp.publicKey, signed, "different")).toBe(false);
  });

  it("fails verification with the wrong public key", () => {
    const kp = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const signed = engine.signPayload(kp.privateKey, "x");
    expect(engine.verifyPayload(other.publicKey, signed)).toBe(false);
  });

  it("serializes and deserializes attached and detached payloads", () => {
    const kp = generateSigningKeyPair();
    const attached = engine.signPayload(kp.privateKey, "data");
    const roundAttached = SignedPayload.deserialize(attached.serialize());
    expect(engine.verifyPayload(kp.publicKey, roundAttached)).toBe(true);

    const detached = engine.signDetached(kp.privateKey, "data2");
    const roundDetached = SignedPayload.deserialize(detached.serialize());
    expect(roundDetached.isDetached).toBe(true);
    expect(engine.verifyPayload(kp.publicKey, roundDetached, "data2")).toBe(true);
  });

  it("rejects a tampered signature after deserialization", () => {
    const kp = generateSigningKeyPair();
    const signed = engine.signDetached(kp.privateKey, "msg");
    const json = signed.toJSON();
    const bytes = signed.signature.bytes;
    bytes[0] ^= 0xff;
    json.signature = Buffer.from(bytes).toString("base64");
    const tampered = SignedPayload.fromJSON(json);
    expect(engine.verifyPayload(kp.publicKey, tampered, "msg")).toBe(false);
  });
});

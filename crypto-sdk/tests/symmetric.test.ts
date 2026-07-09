import { describe, it, expect } from "vitest";
import {
  generateKey,
  encrypt,
  decrypt,
  SymmetricKey,
  EncryptedPayload,
  bytesToUtf8,
  utf8ToBytes,
  randomBytes,
  generateNonce,
  DecryptionError,
  InvalidCiphertextError,
  ValidationError,
  GCM_NONCE_BYTES,
} from "../src/index.js";

describe("symmetric (AES-256-GCM)", () => {
  it("round-trips a UTF-8 string", () => {
    const key = generateKey();
    const payload = encrypt(key, "the quick brown fox");
    expect(bytesToUtf8(decrypt(key, payload))).toBe("the quick brown fox");
  });

  it("round-trips empty plaintext", () => {
    const key = generateKey();
    const payload = encrypt(key, new Uint8Array(0));
    expect(decrypt(key, payload)).toHaveLength(0);
  });

  it("round-trips binary payloads", () => {
    const key = generateKey();
    const data = randomBytes(4096);
    const payload = encrypt(key, data);
    expect([...decrypt(key, payload)]).toEqual([...data]);
  });

  it("round-trips a large (1 MiB) payload", () => {
    const key = generateKey();
    const data = randomBytes(1024 * 1024);
    const payload = encrypt(key, data);
    expect(decrypt(key, payload)).toEqual(data);
  });

  it("produces a fresh random nonce each call (different ciphertext for same input)", () => {
    const key = generateKey();
    const a = encrypt(key, "same");
    const b = encrypt(key, "same");
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it("supports and enforces AAD", () => {
    const key = generateKey();
    const payload = encrypt(key, "secret", { aad: "header-v1" });
    expect(bytesToUtf8(decrypt(key, payload, { aad: "header-v1" }))).toBe("secret");
    // wrong AAD must fail authentication
    expect(() => decrypt(key, payload, { aad: "header-v2" })).toThrow(DecryptionError);
    // missing AAD must fail authentication
    expect(() => decrypt(key, payload)).toThrow(DecryptionError);
  });

  it("fails with the WRONG KEY", () => {
    const key = generateKey();
    const other = generateKey();
    const payload = encrypt(key, "hello");
    expect(() => decrypt(other, payload)).toThrow(DecryptionError);
  });

  it("fails on TAMPERED ciphertext", () => {
    const key = generateKey();
    const payload = encrypt(key, "hello world");
    const ct = payload.ciphertext;
    ct[0] ^= 0xff;
    const tampered = new EncryptedPayload({
      nonce: payload.nonce,
      ciphertext: ct,
      authTag: payload.authTag,
    });
    expect(() => decrypt(key, tampered)).toThrow(DecryptionError);
  });

  it("fails on TAMPERED auth tag", () => {
    const key = generateKey();
    const payload = encrypt(key, "hello world");
    const tag = payload.authTag;
    tag[0] ^= 0xff;
    const tampered = new EncryptedPayload({
      nonce: payload.nonce,
      ciphertext: payload.ciphertext,
      authTag: tag,
    });
    expect(() => decrypt(key, tampered)).toThrow(DecryptionError);
  });

  it("fails with the WRONG NONCE", () => {
    const key = generateKey();
    const payload = encrypt(key, "hello world");
    const wrong = new EncryptedPayload({
      nonce: generateNonce(),
      ciphertext: payload.ciphertext,
      authTag: payload.authTag,
    });
    expect(() => decrypt(key, wrong)).toThrow(DecryptionError);
  });

  it("accepts an explicit valid nonce and rejects an invalid-length one", () => {
    const key = generateKey();
    const nonce = generateNonce(GCM_NONCE_BYTES);
    const payload = encrypt(key, "hi", { nonce });
    expect(payload.nonce).toEqual(nonce);
    expect(() => encrypt(key, "hi", { nonce: randomBytes(8) })).toThrow(ValidationError);
  });

  it("serializes and deserializes an envelope losslessly", () => {
    const key = generateKey();
    const payload = encrypt(key, "persist me", { aad: "ctx" });
    const wire = payload.serialize();
    expect(typeof wire).toBe("string");
    const restored = EncryptedPayload.deserialize(wire);
    expect(bytesToUtf8(decrypt(key, restored, { aad: "ctx" }))).toBe("persist me");
  });

  it("rejects malformed serialized envelopes", () => {
    expect(() => EncryptedPayload.deserialize("not json")).toThrow(InvalidCiphertextError);
    expect(() => EncryptedPayload.deserialize(JSON.stringify({ v: 999 }))).toThrow(
      InvalidCiphertextError,
    );
  });

  it("SymmetricKey enforces a 32-byte length", () => {
    expect(() => SymmetricKey.fromBytes(randomBytes(16))).toThrow();
    expect(SymmetricKey.fromBytes(randomBytes(32))).toBeInstanceOf(SymmetricKey);
  });

  it("SymmetricKey serializes to/from base64 and hex", () => {
    const key = generateKey();
    expect(SymmetricKey.fromBase64(key.toBase64()).bytes).toEqual(key.bytes);
    expect(SymmetricKey.fromHex(key.toHex()).bytes).toEqual(key.bytes);
  });

  it("SymmetricKey.bytes returns a defensive copy", () => {
    const key = generateKey();
    const b = key.bytes;
    b.fill(0);
    expect(key.bytes).not.toEqual(b);
  });

  it("rejects a non-SymmetricKey argument", () => {
    // @ts-expect-error runtime guard
    expect(() => encrypt("not a key", "x")).toThrow(ValidationError);
  });

  it("interop: raw AAD bytes equal their UTF-8 string form", () => {
    const key = generateKey();
    const payload = encrypt(key, "m", { aad: utf8ToBytes("ctx") });
    expect(bytesToUtf8(decrypt(key, payload, { aad: "ctx" }))).toBe("m");
  });
});

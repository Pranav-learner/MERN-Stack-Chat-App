import { describe, it, expect } from "vitest";
import {
  SymmetricKey,
  randomBytes,
  bytesToUtf8,
  DecryptionError,
  EncryptedPayload,
} from "@securechat/crypto-sdk";
import { SymmetricEngine, EncryptedBuffer, encryptData, decryptData } from "../src/index.js";

describe("SymmetricEngine", () => {
  it("round-trips UTF-8 and binary", () => {
    const engine = SymmetricEngine.withRandomKey();
    expect(bytesToUtf8(engine.decrypt(engine.encrypt("héllo 🔐")))).toBe("héllo 🔐");
    const bin = randomBytes(2048);
    expect(engine.decrypt(engine.encrypt(bin))).toEqual(bin);
  });

  it("enforces AAD", () => {
    const engine = SymmetricEngine.withRandomKey();
    const payload = engine.encrypt("secret", { aad: "ctx" });
    expect(bytesToUtf8(engine.decrypt(payload, { aad: "ctx" }))).toBe("secret");
    expect(() => engine.decrypt(payload, { aad: "wrong" })).toThrow(DecryptionError);
  });

  it("fails with the wrong key", () => {
    const payload = SymmetricEngine.withRandomKey().encrypt("hi");
    expect(() => SymmetricEngine.withRandomKey().decrypt(payload)).toThrow(DecryptionError);
  });

  it("uses a fresh nonce per call", () => {
    const engine = SymmetricEngine.withKey(SymmetricKey.generate());
    const a = engine.encrypt("same");
    const b = engine.encrypt("same");
    expect(a.nonce).not.toEqual(b.nonce);
  });

  it("encryptToBuffer attaches metadata and round-trips", () => {
    const engine = SymmetricEngine.withRandomKey();
    const buf = engine.encryptToBuffer(randomBytes(100), {
      metadata: { contentType: "application/octet-stream" },
    });
    expect(buf).toBeInstanceOf(EncryptedBuffer);
    expect(buf.metadata.contentType).toBe("application/octet-stream");
    expect(buf.metadata.originalSize).toBe(100);
    expect(engine.decryptBuffer(buf)).toHaveLength(100);
  });

  it("EncryptedBuffer serializes and deserializes", () => {
    const engine = SymmetricEngine.withRandomKey();
    const buf = engine.encryptToBuffer("data", { metadata: { name: "blob" } });
    const restored = EncryptedBuffer.deserialize(buf.serialize());
    expect(restored.metadata.name).toBe("blob");
    expect(bytesToUtf8(engine.decryptBuffer(restored))).toBe("data");
  });

  it("functional encryptData/decryptData work", () => {
    const key = SymmetricKey.generate();
    const payload = encryptData(key, "hi");
    expect(bytesToUtf8(decryptData(key, payload))).toBe("hi");
  });

  it("detects tampered ciphertext", () => {
    const engine = SymmetricEngine.withRandomKey();
    const payload = engine.encrypt("hello world");
    const ct = payload.ciphertext;
    ct[0] ^= 0xff;
    const tampered = new EncryptedPayload({
      nonce: payload.nonce,
      ciphertext: ct,
      authTag: payload.authTag,
    });
    expect(() => engine.decrypt(tampered)).toThrow(DecryptionError);
  });
});

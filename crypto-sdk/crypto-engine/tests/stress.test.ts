import { describe, it, expect } from "vitest";
import { SymmetricKey, randomBytes, generateSigningKeyPair } from "@securechat/crypto-sdk";
import { SymmetricEngine, SignatureEngine, FileEncryptor } from "../src/index.js";

/** Fast byte-array equality (native memcmp) — avoids vitest's slow deep toEqual on large arrays. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
}

/** Build `size` random bytes in <=1 MiB blocks (SDK randomBytes caps at 1 MiB). */
function bigRandom(size: number): Uint8Array {
  const out = new Uint8Array(size);
  const BLOCK = 1024 * 1024;
  for (let offset = 0; offset < size; offset += BLOCK) {
    const len = Math.min(BLOCK, size - offset);
    out.set(randomBytes(len), offset);
  }
  return out;
}

describe("stress / repeated operations", () => {
  it("performs 5000 encrypt/decrypt cycles without drift", () => {
    const engine = SymmetricEngine.withRandomKey();
    for (let i = 0; i < 5000; i++) {
      const data = randomBytes(64);
      expect(engine.decrypt(engine.encrypt(data))).toEqual(data);
    }
  });

  it("performs 2000 sign/verify cycles", () => {
    const engine = new SignatureEngine();
    const kp = generateSigningKeyPair();
    for (let i = 0; i < 2000; i++) {
      const msg = randomBytes(32);
      const signed = engine.signPayload(kp.privateKey, msg);
      expect(engine.verifyPayload(kp.publicKey, signed)).toBe(true);
    }
  });

  it("encrypts and decrypts a large 5 MiB file across many chunks", () => {
    const fe = new FileEncryptor({ chunkSize: 64 * 1024 });
    const key = SymmetricKey.generate();
    const data = bigRandom(5 * 1024 * 1024);
    const enc = fe.encryptBuffer(data, key);
    expect(enc.chunkCount).toBe(Math.ceil(data.length / (64 * 1024)));
    expect(bytesEqual(fe.decryptBuffer(enc, key), data)).toBe(true);
  });

  it("handles many independent files/keys", () => {
    const fe = new FileEncryptor({ chunkSize: 4096 });
    for (let i = 0; i < 200; i++) {
      const key = SymmetricKey.generate();
      const data = randomBytes(1000 + i);
      expect(bytesEqual(fe.decryptBuffer(fe.encryptBuffer(data, key), key), data)).toBe(true);
    }
  });
});

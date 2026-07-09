import { describe, it, expect } from "vitest";
import {
  hkdf,
  deriveKeyFromPassword,
  randomBytes,
  HashAlgorithm,
  ValidationError,
  KeyDerivationError,
} from "../src/index.js";

describe("kdf", () => {
  describe("hkdf", () => {
    it("is deterministic for the same inputs", () => {
      const ikm = randomBytes(32);
      const salt = randomBytes(16);
      const a = hkdf(ikm, { salt, info: "ctx", length: 32 });
      const b = hkdf(ikm, { salt, info: "ctx", length: 32 });
      expect(a).toEqual(b);
      expect(a).toHaveLength(32);
    });

    it("varies with info, salt, and length", () => {
      const ikm = randomBytes(32);
      const base = hkdf(ikm, { info: "a", length: 32 });
      expect(hkdf(ikm, { info: "b", length: 32 })).not.toEqual(base);
      expect(hkdf(ikm, { info: "a", salt: randomBytes(16), length: 32 })).not.toEqual(base);
      expect(hkdf(ikm, { info: "a", length: 16 })).toHaveLength(16);
    });

    it("matches RFC 5869 Test Case 1 (SHA-256)", () => {
      const ikm = new Uint8Array(22).fill(0x0b);
      const salt = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      const info = new Uint8Array([0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9]);
      const okm = hkdf(ikm, { salt, info, length: 42, hash: HashAlgorithm.SHA256 });
      expect(Buffer.from(okm).toString("hex")).toBe(
        "3cb25f25faacd57a90434f64d0362f2a" +
          "2d2d0a90cf1a5a4c5db02d56ecc4c5bf" +
          "34007208d5b887185865",
      );
    });

    it("rejects empty ikm and out-of-range length", () => {
      expect(() => hkdf(new Uint8Array(0))).toThrow(ValidationError);
      expect(() => hkdf(randomBytes(8), { length: 0 })).toThrow(ValidationError);
      expect(() => hkdf(randomBytes(8), { length: 255 * 64 + 1 })).toThrow(ValidationError);
    });
  });

  describe("deriveKeyFromPassword (scrypt)", () => {
    it("is deterministic per (password, salt) and salt-sensitive", () => {
      const salt = randomBytes(16);
      // Low cost for test speed.
      const a = deriveKeyFromPassword("hunter2", salt, { cost: 1024 });
      const b = deriveKeyFromPassword("hunter2", salt, { cost: 1024 });
      const c = deriveKeyFromPassword("hunter2", randomBytes(16), { cost: 1024 });
      expect(a).toEqual(b);
      expect(a).not.toEqual(c);
      expect(a).toHaveLength(32);
    });

    it("wraps invalid parameters in KeyDerivationError", () => {
      // N must be a power of two > 1; 3 is invalid.
      expect(() => deriveKeyFromPassword("p", randomBytes(16), { cost: 3 })).toThrow(
        KeyDerivationError,
      );
    });
  });
});

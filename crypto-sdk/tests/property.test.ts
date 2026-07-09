import { describe, it, expect } from "vitest";
import {
  SymmetricKey,
  EncryptedPayload,
  Signature,
  generateKeyPair,
  generateSigningKeyPair,
  deriveSharedSecret,
  sign,
  verify,
  encrypt,
  decrypt,
  hkdf,
  randomBytes,
  randomInt,
  toBase64,
  fromBase64,
  toBase64Url,
  fromBase64Url,
  toHex,
  fromHex,
  utf8ToBytes,
  bytesToUtf8,
  EncodingError,
  DecryptionError,
  InvalidCiphertextError,
} from "../src/index.js";

/**
 * Property-based / randomized tests. Each property is a universally-true
 * invariant checked over many random inputs. These complement the fixed
 * known-answer vectors in the other suites.
 */

const ROUNDS = 200;
/** Random byte length in [0, max]; 0-safe (randomBytes requires >= 1). */
const rlen = (max: number): number => randomInt(0, max + 1);
const rbytes = (n: number): Uint8Array => (n === 0 ? new Uint8Array(0) : randomBytes(n));

describe("property: symmetric round-trips", () => {
  it("decrypt(encrypt(x)) === x for random sizes and AAD", () => {
    const key = SymmetricKey.generate();
    for (let i = 0; i < ROUNDS; i++) {
      const pt = rbytes(rlen(4096));
      const useAad = i % 2 === 0;
      const aad = useAad ? rbytes(rlen(64)) : undefined;
      const payload = encrypt(key, pt, aad ? { aad } : {});
      const back = decrypt(key, payload, aad ? { aad } : {});
      expect(back).toEqual(pt);
    }
  });

  it("any single-byte ciphertext mutation is rejected", () => {
    const key = SymmetricKey.generate();
    for (let i = 0; i < 100; i++) {
      const payload = encrypt(key, rbytes(rlen(256) + 1));
      const ct = payload.ciphertext;
      const pos = randomInt(0, ct.length);
      ct[pos] = ct[pos]! ^ (1 << randomInt(0, 8));
      const mutated = new EncryptedPayload({
        nonce: payload.nonce,
        ciphertext: ct,
        authTag: payload.authTag,
      });
      expect(() => decrypt(key, mutated)).toThrow(DecryptionError);
    }
  });

  it("serialize/deserialize preserves the envelope", () => {
    const key = SymmetricKey.generate();
    for (let i = 0; i < 50; i++) {
      const payload = encrypt(key, rbytes(rlen(1000)));
      const back = EncryptedPayload.deserialize(payload.serialize());
      expect(decrypt(key, back)).toEqual(decrypt(key, payload));
    }
  });
});

describe("property: signatures", () => {
  it("verify(sign(m)) is always true; tampered m is always false", () => {
    for (let i = 0; i < 100; i++) {
      const kp = generateSigningKeyPair();
      const msg = rbytes(rlen(512) + 1);
      const sig = sign(kp.privateKey, msg);
      expect(verify(kp.publicKey, msg, sig)).toBe(true);
      const tampered = msg.slice();
      const pos = randomInt(0, tampered.length);
      tampered[pos] = tampered[pos]! ^ 0xff;
      expect(verify(kp.publicKey, tampered, sig)).toBe(false);
    }
  });

  it("a signature never verifies under a different key", () => {
    for (let i = 0; i < 50; i++) {
      const a = generateSigningKeyPair();
      const b = generateSigningKeyPair();
      const msg = rbytes(rlen(128) + 1);
      expect(verify(b.publicKey, msg, sign(a.privateKey, msg))).toBe(false);
    }
  });
});

describe("property: X25519 agreement is symmetric", () => {
  it("both sides derive the same secret over random key pairs", () => {
    for (let i = 0; i < 50; i++) {
      const a = generateKeyPair();
      const b = generateKeyPair();
      expect(deriveSharedSecret(a.privateKey, b.publicKey).bytes).toEqual(
        deriveSharedSecret(b.privateKey, a.publicKey).bytes,
      );
    }
  });
});

describe("property: HKDF", () => {
  it("is deterministic and separated by info", () => {
    for (let i = 0; i < 50; i++) {
      const ikm = randomBytes(32);
      const info = rbytes(rlen(16) + 1);
      const a = hkdf(ikm, { info, length: 32 });
      const b = hkdf(ikm, { info, length: 32 });
      expect(a).toEqual(b);
      const other = hkdf(ikm, { info: concat(info, Uint8Array.of(0)), length: 32 });
      expect(other).not.toEqual(a);
    }
  });
});

describe("property: encoding round-trips", () => {
  it("base64 / base64url / hex / utf8 all round-trip random data", () => {
    for (let i = 0; i < ROUNDS; i++) {
      const bytes = rbytes(rlen(256));
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
      expect(fromHex(toHex(bytes))).toEqual(bytes);
    }
    for (const s of ["", "a", "héllo", "日本語😀", "x".repeat(500)]) {
      expect(bytesToUtf8(utf8ToBytes(s))).toBe(s);
    }
  });
});

describe("malformed input never crashes — always typed errors", () => {
  it("rejects malformed encodings", () => {
    for (const bad of ["!!!", "====", "a", "zz zz"]) {
      expect(() => fromHex(bad)).toThrow(EncodingError);
    }
    expect(() => fromBase64("**not base64**")).toThrow(EncodingError);
    expect(() => fromBase64Url("has spaces")).toThrow(EncodingError);
  });

  it("rejects malformed serialized envelopes/signatures", () => {
    const garbage = ["", "{}", "not json", "[1,2,3]", JSON.stringify({ v: 99 })];
    for (const g of garbage) {
      expect(() => EncryptedPayload.deserialize(g)).toThrow(InvalidCiphertextError);
    }
    expect(() => Signature.fromBase64("!!!")).toThrow();
  });

  it("survives fuzzed random strings fed to deserializers", () => {
    for (let i = 0; i < 200; i++) {
      const s = toBase64(randomBytes(randomInt(1, 40)));
      // Should throw a typed error, never hang or throw something untyped/uncaught.
      let threw = false;
      try {
        EncryptedPayload.deserialize(s);
      } catch (e) {
        threw = true;
        expect(e).toBeInstanceOf(Error);
      }
      expect(threw).toBe(true);
    }
  });
});

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

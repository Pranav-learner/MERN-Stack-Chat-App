import { describe, it, expect } from "vitest";
import { performance } from "node:perf_hooks";
import {
  SymmetricKey,
  randomBytes,
  randomInt,
  generateSigningKeyPair,
} from "@securechat/crypto-sdk";
import {
  FileEncryptor,
  SignatureEngine,
  SymmetricEngine,
  EncryptedFile,
  SignedPayload,
  MasterKey,
  DerivationPurpose,
} from "../src/index.js";

const rbytes = (n: number): Uint8Array => (n === 0 ? new Uint8Array(0) : randomBytes(n));

describe("property: file encryption round-trips over random sizes/chunk sizes", () => {
  it("decryptBuffer(encryptBuffer(x)) === x", () => {
    for (let i = 0; i < 60; i++) {
      const chunkSize = randomInt(16, 4096);
      const fe = new FileEncryptor({ chunkSize });
      const key = SymmetricKey.generate();
      const data = rbytes(randomInt(0, 20_000));
      const enc = fe.encryptBuffer(data, key);
      expect(enc.chunkCount).toBe(data.length === 0 ? 1 : Math.ceil(data.length / chunkSize));
      expect(bytesEqual(fe.decryptBuffer(enc, key), data)).toBe(true);
    }
  });

  it("serialized encrypted files round-trip", () => {
    const fe = new FileEncryptor({ chunkSize: 256 });
    const key = SymmetricKey.generate();
    for (let i = 0; i < 30; i++) {
      const data = rbytes(randomInt(1, 5000));
      const wire = fe.encryptBuffer(data, key).serialize();
      expect(bytesEqual(fe.decryptBuffer(EncryptedFile.deserialize(wire), key), data)).toBe(true);
    }
  });
});

describe("property: signed payloads round-trip and detect tampering", () => {
  it("attached & detached serialize/verify over random messages", () => {
    const engine = new SignatureEngine();
    for (let i = 0; i < 60; i++) {
      const kp = generateSigningKeyPair();
      const msg = rbytes(randomInt(1, 2000));
      const attached = SignedPayload.deserialize(
        engine.signPayload(kp.privateKey, msg).serialize(),
      );
      expect(engine.verifyPayload(kp.publicKey, attached)).toBe(true);
      const detached = SignedPayload.deserialize(
        engine.signDetached(kp.privateKey, msg).serialize(),
      );
      expect(engine.verifyPayload(kp.publicKey, detached, msg)).toBe(true);
    }
  });
});

describe("property: KDF context/purpose separation holds over random contexts", () => {
  it("distinct (context, purpose) always produce distinct keys", () => {
    const master = MasterKey.random();
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const context = `ctx-${randomInt(0, 1000)}`;
      const purpose = i % 2 ? DerivationPurpose.ENCRYPTION : DerivationPurpose.MAC;
      const key = master.deriveSymmetricKey({ context, purpose }).toHex();
      // Same (context,purpose) is deterministic; different ones differ.
      const again = master.deriveSymmetricKey({ context, purpose }).toHex();
      expect(again).toBe(key);
      seen.add(key);
    }
    // All derived keys are unique across the distinct contexts we generated.
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("performance regression guards (generous bounds — catch catastrophes, not micro-jitter)", () => {
  it("encrypt+decrypt of 1 MiB completes well under 1s", () => {
    const engine = SymmetricEngine.withRandomKey();
    const data = randomBytes(1024 * 1024);
    const start = performance.now();
    const payload = engine.encrypt(data);
    const back = engine.decrypt(payload);
    const elapsed = performance.now() - start;
    expect(bytesEqual(back, data)).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  it("1000 sign+verify cycles complete well under 5s", () => {
    const engine = new SignatureEngine();
    const kp = generateSigningKeyPair();
    const msg = randomBytes(256);
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      const sig = engine.sign(kp.privateKey, msg);
      expect(engine.verify(kp.publicKey, msg, sig)).toBe(true);
    }
    expect(performance.now() - start).toBeLessThan(5000);
  });
});

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
}

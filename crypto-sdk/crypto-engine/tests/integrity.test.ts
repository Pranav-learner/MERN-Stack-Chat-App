import { describe, it, expect } from "vitest";
import { SymmetricKey, encrypt, generateSigningKeyPair, randomBytes } from "@securechat/crypto-sdk";
import {
  IntegrityVerifier,
  computeChecksum,
  verifyChecksum,
  assertChecksum,
  IntegrityError,
  SignatureEngine,
} from "../src/index.js";

describe("checksums", () => {
  it("computes and verifies (constant-time)", () => {
    const data = randomBytes(256);
    const sum = computeChecksum(data);
    expect(sum).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyChecksum(data, sum)).toBe(true);
    expect(verifyChecksum(data, "0".repeat(64))).toBe(false);
  });

  it("assertChecksum throws on mismatch", () => {
    expect(() => assertChecksum("abc", computeChecksum("abc"))).not.toThrow();
    expect(() => assertChecksum("abc", computeChecksum("abd"))).toThrow(IntegrityError);
  });
});

describe("IntegrityVerifier", () => {
  const verifier = new IntegrityVerifier();

  it("tryDecrypt returns plaintext on success", () => {
    const key = SymmetricKey.generate();
    const payload = encrypt(key, "hello");
    const r = verifier.tryDecrypt(key, payload);
    expect(r.ok).toBe(true);
    expect(r.plaintext).toBeDefined();
  });

  it("tryDecrypt reports authentication failure (wrong key)", () => {
    const payload = encrypt(SymmetricKey.generate(), "hello");
    const r = verifier.tryDecrypt(SymmetricKey.generate(), payload);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("authentication-failed");
  });

  it("detects version mismatch", () => {
    expect(verifier.checkVersion(1, 1).ok).toBe(true);
    const r = verifier.checkVersion(2, 1);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("version-mismatch");
  });

  it("verifies signed payloads and flags bad signatures / missing message", () => {
    const engine = new SignatureEngine();
    const kp = generateSigningKeyPair();
    const attached = engine.signPayload(kp.privateKey, "data");
    expect(verifier.verifySignedPayload(kp.publicKey, attached).ok).toBe(true);

    const detached = engine.signDetached(kp.privateKey, "data");
    expect(verifier.verifySignedPayload(kp.publicKey, detached).code).toBe("missing-message");
    expect(verifier.verifySignedPayload(kp.publicKey, detached, "data").ok).toBe(true);
    expect(verifier.verifySignedPayload(kp.publicKey, detached, "other").code).toBe("bad-signature");
  });
});

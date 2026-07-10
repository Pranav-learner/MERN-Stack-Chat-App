import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  generateKeyPair,
  exportRawPublicKey,
  decodeRawPublicKey,
  validateRawPublicKey,
  importPublicKey,
  deriveSharedSecret,
  isSmallOrderPoint,
  isAllZero,
  constantTimeEqual,
  secretCommitment,
  signEphemeralKey,
  verifyEphemeralKey,
} from "../crypto/x25519.js";
import {
  deriveSecret,
  validateSecret,
  secretsEqual,
  assertCommitmentsMatch,
  commitmentsMatch,
  disposeSecret,
} from "../derivation/sharedSecret.js";
import { EphemeralKeyStore } from "../exchange/ephemeralKeys.js";
import { InvalidPublicKeyError, SharedSecretError, SharedSecretMismatchError } from "../errors.js";
import { makeIdentity } from "./helpers.js";

describe("x25519 primitives", () => {
  it("generates 32-byte raw public keys", () => {
    const kp = generateKeyPair();
    assert.equal(Buffer.from(kp.publicKeyRaw, "base64").length, 32);
    assert.equal(decodeRawPublicKey(kp.publicKeyRaw).length, 32);
  });

  it("both parties derive the SAME shared secret (never transmitted)", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const sAB = deriveSharedSecret(a.privateKey, b.publicKeyRaw);
    const sBA = deriveSharedSecret(b.privateKey, a.publicKeyRaw);
    assert.equal(sAB.length, 32);
    assert.ok(sAB.equals(sBA));
  });

  it("different peers derive DIFFERENT secrets", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const c = generateKeyPair();
    const sAB = deriveSharedSecret(a.privateKey, b.publicKeyRaw);
    const sAC = deriveSharedSecret(a.privateKey, c.publicKeyRaw);
    assert.ok(!sAB.equals(sAC));
  });

  it("rejects malformed / wrong-length public keys", () => {
    assert.throws(() => decodeRawPublicKey("not base64!!"), InvalidPublicKeyError);
    assert.throws(() => decodeRawPublicKey(Buffer.alloc(16).toString("base64")), InvalidPublicKeyError);
    assert.throws(() => validateRawPublicKey(Buffer.alloc(31)), InvalidPublicKeyError);
  });

  it("rejects small-order points and all-zero secrets", () => {
    const zero = Buffer.alloc(32);
    assert.equal(isSmallOrderPoint(zero), true);
    assert.equal(isSmallOrderPoint(Buffer.from("01".padEnd(64, "0"), "hex")), true);
    assert.throws(() => validateRawPublicKey(zero), InvalidPublicKeyError);
    // deriving against a small-order point is rejected before/at derivation
    const a = generateKeyPair();
    assert.throws(() => deriveSharedSecret(a.privateKey, zero.toString("base64")), InvalidPublicKeyError);
  });

  it("importPublicKey round-trips a valid key", () => {
    const kp = generateKeyPair();
    const imported = importPublicKey(kp.publicKeyRaw);
    assert.equal(exportRawPublicKey(imported), kp.publicKeyRaw);
  });

  it("commitment is one-way, stable, and not the secret", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const secret = deriveSharedSecret(a.privateKey, b.publicKeyRaw);
    const c1 = secretCommitment(secret);
    const c2 = secretCommitment(secret);
    assert.equal(c1, c2);
    assert.match(c1, /^[0-9a-f]{64}$/);
    assert.notEqual(c1, secret.toString("hex"));
  });

  it("constant-time + all-zero helpers", () => {
    assert.equal(constantTimeEqual(Buffer.from("aa"), Buffer.from("aa")), true);
    assert.equal(constantTimeEqual(Buffer.from("aa"), Buffer.from("ab")), false);
    assert.equal(constantTimeEqual(Buffer.from("a"), Buffer.from("aa")), false);
    assert.equal(isAllZero(Buffer.alloc(4)), true);
    assert.equal(isAllZero(Buffer.from([0, 1, 0])), false);
  });

  it("signs + verifies an ephemeral key against an identity (authenticated KE)", () => {
    const identity = makeIdentity("alice");
    const eph = generateKeyPair();
    const raw = decodeRawPublicKey(eph.publicKeyRaw);
    const sig = signEphemeralKey(identity.privateKey, raw);
    assert.equal(verifyEphemeralKey(raw, sig, identity.publicKey), true);
    // wrong identity key fails
    const other = makeIdentity("bob");
    assert.equal(verifyEphemeralKey(raw, sig, other.publicKey), false);
    // tampered key fails
    const tampered = Buffer.from(raw);
    tampered[0] ^= 0xff;
    assert.equal(verifyEphemeralKey(tampered, sig, identity.publicKey), false);
  });
});

describe("shared-secret derivation module", () => {
  it("deriveSecret yields matching secrets + commitments for both sides", () => {
    const store = new EphemeralKeyStore();
    const a = store.generate("h", "initiator");
    const b = store.generate("h", "responder");
    const aSide = deriveSecret(store.privateKey("h", "initiator"), b.publicKey);
    const bSide = deriveSecret(store.privateKey("h", "responder"), a.publicKey);
    assert.ok(secretsEqual(aSide.secret, bSide.secret));
    assert.equal(aSide.commitment, bSide.commitment);
    assert.doesNotThrow(() => assertCommitmentsMatch(aSide.commitment, bSide.commitment));
    assert.equal(commitmentsMatch(aSide.commitment, "0".repeat(64)), false);
    assert.throws(() => assertCommitmentsMatch(aSide.commitment, "0".repeat(64)), SharedSecretMismatchError);
  });

  it("validateSecret rejects wrong length / all-zero", () => {
    assert.throws(() => validateSecret(Buffer.alloc(16)), SharedSecretError);
    assert.throws(() => validateSecret(Buffer.alloc(32)), SharedSecretError);
    assert.doesNotThrow(() => validateSecret(crypto.randomBytes(32)));
  });

  it("disposeSecret zero-fills the buffer", () => {
    const s = crypto.randomBytes(32);
    disposeSecret(s);
    assert.ok(s.equals(Buffer.alloc(32)));
  });
});

describe("EphemeralKeyStore lifecycle", () => {
  it("generates fresh keys, exposes private key, destroys them", () => {
    const store = new EphemeralKeyStore();
    const b1 = store.generate("h1", "initiator");
    const b2 = store.generate("h1", "initiator"); // regenerate replaces
    assert.notEqual(b1.publicKey, b2.publicKey); // fresh each time (no reuse)
    assert.equal(store.has("h1", "initiator"), true);
    assert.ok(store.privateKey("h1", "initiator"));
    assert.equal(store.destroy("h1", "initiator"), true);
    assert.equal(store.has("h1", "initiator"), false);
  });

  it("never reuses ephemeral keys across handshakes", () => {
    const store = new EphemeralKeyStore();
    const keys = new Set();
    for (let i = 0; i < 20; i++) keys.add(store.generate(`h${i}`, "initiator").publicKey);
    assert.equal(keys.size, 20);
  });

  it("throws when the private key was destroyed", () => {
    const store = new EphemeralKeyStore();
    store.generate("h", "initiator");
    store.destroy("h", "initiator");
    assert.throws(() => store.privateKey("h", "initiator"));
  });
});

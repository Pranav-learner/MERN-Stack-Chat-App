import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  negotiateCrypto,
  canNegotiateCrypto,
  negotiateCryptoVersion,
  isAlgorithmSupported,
  cryptoCapabilities,
} from "../negotiation/cryptoNegotiation.js";
import {
  validateBundle,
  verifyBundleSignature,
  validatePeers,
  validateAgainstExchange,
  assertNotDuplicateKey,
  assertNotReplayedKey,
  assertExchangeFresh,
  validateNegotiationPayload,
} from "../validation/keyAgreementValidators.js";
import { generateKeyPair, decodeRawPublicKey, signEphemeralKey } from "../crypto/x25519.js";
import { buildBundle } from "../exchange/ephemeralKeys.js";
import { ExchangeState } from "../types.js";
import {
  CryptoNegotiationError,
  KeyAgreementValidationError,
  InvalidPublicKeyError,
  DuplicateExchangeError,
  ReplayError,
  KeyAgreementExpiredError,
  PeerAuthenticationError,
  UnknownPeerError,
} from "../errors.js";
import { makeIdentity } from "./helpers.js";

const bundleOf = (identity) => {
  const kp = generateKeyPair();
  return buildBundle(kp.publicKeyRaw, "k-1", Date.now(), identity ? { identityPrivateKey: identity.privateKey, identityPublicKey: identity.publicKey } : {});
};

describe("crypto negotiation", () => {
  it("agrees x25519 + crypto version", () => {
    const r = negotiateCrypto({ algorithms: ["x25519"] }, { algorithms: ["x25519"] });
    assert.equal(r.algorithm, "x25519");
    assert.equal(r.cryptoVersion, "1.0");
  });

  it("defaults to supported algorithms when unspecified", () => {
    assert.equal(negotiateCrypto({}, {}).algorithm, "x25519");
  });

  it("fails when there is no common algorithm", () => {
    assert.throws(() => negotiateCrypto({ algorithms: ["kyber"] }, { algorithms: ["x25519"] }), CryptoNegotiationError);
    assert.equal(canNegotiateCrypto({ algorithms: ["kyber"] }, { algorithms: ["p256"] }), false);
  });

  it("negotiates and rejects unsupported crypto versions", () => {
    assert.equal(negotiateCryptoVersion("1.0", "1.0"), "1.0");
    assert.throws(() => negotiateCryptoVersion("1.0", "2.0"), CryptoNegotiationError);
  });

  it("advertises capabilities", () => {
    assert.equal(isAlgorithmSupported("x25519"), true);
    assert.equal(isAlgorithmSupported("rsa"), false);
    const caps = cryptoCapabilities();
    assert.ok(caps.algorithms.includes("x25519"));
    assert.equal(caps.cryptoVersion, "1.0");
  });

  it("validates negotiation payloads (corruption)", () => {
    assert.throws(() => validateNegotiationPayload(null), KeyAgreementValidationError);
    assert.throws(() => validateNegotiationPayload({ algorithms: "x25519" }), KeyAgreementValidationError);
    assert.throws(() => validateNegotiationPayload({ cryptoVersion: 1 }), KeyAgreementValidationError);
    assert.doesNotThrow(() => validateNegotiationPayload({ algorithms: ["x25519"], cryptoVersion: "1.0" }));
  });
});

describe("bundle + peer validation", () => {
  it("accepts a well-formed bundle; rejects bad algorithm/key", () => {
    assert.doesNotThrow(() => validateBundle(bundleOf()));
    assert.throws(() => validateBundle({ algorithm: "rsa", publicKey: "x" }), KeyAgreementValidationError);
    assert.throws(() => validateBundle({ algorithm: "x25519" }), InvalidPublicKeyError);
    assert.throws(() => validateBundle({ algorithm: "x25519", publicKey: Buffer.alloc(32).toString("base64") }), InvalidPublicKeyError); // small-order
  });

  it("verifies signatures when present; enforces requireSignature", () => {
    const identity = makeIdentity("alice");
    const signed = bundleOf(identity);
    assert.doesNotThrow(() => verifyBundleSignature(signed));
    // tamper the identity binding
    const forged = { ...signed, identityPublicKey: makeIdentity("bob").publicKey };
    assert.throws(() => verifyBundleSignature(forged), PeerAuthenticationError);
    // unsigned + requireSignature → throws
    assert.throws(() => verifyBundleSignature(bundleOf(), { requireSignature: true }), PeerAuthenticationError);
    assert.doesNotThrow(() => verifyBundleSignature(bundleOf(), { requireSignature: false }));
  });

  it("validatePeers rejects self + unknown", async () => {
    await assert.rejects(() => validatePeers({ initiator: "a", responder: "a" }), KeyAgreementValidationError);
    const identityLookup = async (u) => (u === "ghost" ? null : { userId: u });
    await assert.rejects(() => validatePeers({ initiator: "a", responder: "ghost" }, { identityLookup }), UnknownPeerError);
    await assert.doesNotReject(() => validatePeers({ initiator: "a", responder: "b" }, { identityLookup }));
  });

  it("guards algorithm mismatch, duplicates, replays, expiry", () => {
    const exchange = {
      handshakeId: "h",
      algorithm: "x25519",
      cryptoVersion: "1.0",
      state: ExchangeState.AWAITING_INITIATOR_KEY,
      initiatorKey: { publicKey: "AAA" },
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    };
    assert.throws(() => validateAgainstExchange({ algorithm: "kyber" }, exchange), KeyAgreementValidationError);
    assert.throws(() => assertNotDuplicateKey(exchange, "initiator"), DuplicateExchangeError);
    assert.throws(() => assertNotReplayedKey(exchange, { publicKey: "AAA" }), ReplayError);
    assert.throws(() => assertExchangeFresh(exchange, Date.now() + 5000), KeyAgreementExpiredError);
    assert.doesNotThrow(() => assertExchangeFresh(exchange, Date.now()));
  });
});

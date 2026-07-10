import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkDowngrade,
  assertNoDowngrade,
  assertTranscriptMatch,
  transcriptHash,
  maxCommonVersion,
} from "../downgrade/downgradeGuard.js";
import {
  validateHeaders,
  validateOrdering,
  validateTransition,
  validateSessionMetadata,
  verifyInboundMessage,
  TranscriptAccumulator,
} from "../integrity/protocolIntegrity.js";
import { DowngradeReason } from "../types.js";
import { DowngradeAttackError, ProtocolIntegrityError } from "../errors.js";
import { buildRequest, buildAccept } from "../../messages/messages.js";
import { HandshakeState } from "../../types.js";

describe("downgrade protection", () => {
  it("passes a clean negotiation + returns a transcript", () => {
    const v = checkDowngrade({
      initiatorOffer: { supportedVersions: ["1.0"], capabilities: ["a", "b"] },
      responderOffer: { supportedVersions: ["1.0"], capabilities: ["a", "b"] },
      negotiated: { version: "1.0", capabilities: ["a", "b"] },
    });
    assert.equal(v.ok, true);
    assert.match(v.transcript, /^[0-9a-f]{64}$/);
  });

  it("blocks below-minimum + insecure versions", () => {
    assert.equal(checkDowngrade({ initiatorOffer: {}, responderOffer: {}, negotiated: { version: "0.9" } }).reason, DowngradeReason.BELOW_MINIMUM_VERSION);
    assert.equal(
      checkDowngrade({ initiatorOffer: {}, responderOffer: {}, negotiated: { version: "1.0" } }, { insecureVersions: new Set(["1.0"]) }).reason,
      DowngradeReason.INSECURE_VERSION,
    );
  });

  it("blocks a forced-lower-than-max-common version", () => {
    const v = checkDowngrade({
      initiatorOffer: { supportedVersions: ["1.0", "1.1"] },
      responderOffer: { supportedVersions: ["1.0", "1.1"] },
      negotiated: { version: "1.0" }, // both support 1.1 → 1.0 is a downgrade
    });
    assert.equal(v.reason, DowngradeReason.NOT_MAX_COMMON_VERSION);
    assert.equal(v.expectedVersion, "1.1");
  });

  it("detects a stripped capability + algorithm", () => {
    assert.equal(
      checkDowngrade({ initiatorOffer: { capabilities: ["a", "b"] }, responderOffer: { capabilities: ["a", "b"] }, negotiated: { version: "1.0", capabilities: ["a"] } }).reason,
      DowngradeReason.CAPABILITY_STRIPPED,
    );
    assert.equal(
      checkDowngrade({ initiatorOffer: { algorithms: ["x25519", "p256"] }, responderOffer: { algorithms: ["x25519"] }, negotiated: { version: "1.0", algorithm: "p256" } }).reason,
      DowngradeReason.ALGORITHM_STRIPPED,
    );
  });

  it("assertNoDowngrade throws; maxCommonVersion picks the highest", () => {
    assert.throws(() => assertNoDowngrade({ initiatorOffer: {}, responderOffer: {}, negotiated: { version: "0.9" } }), DowngradeAttackError);
    assert.equal(maxCommonVersion(["1.0", "1.1"], ["1.0", "1.1", "2.0"]), "1.1");
    assert.equal(maxCommonVersion(["1.0"], ["2.0"]), null);
  });

  it("transcript is order-independent within a party; mismatch detected", () => {
    const a = transcriptHash({ capabilities: ["a", "b"] }, { capabilities: ["c"] });
    const b = transcriptHash({ capabilities: ["b", "a"] }, { capabilities: ["c"] });
    assert.equal(a, b);
    assert.doesNotThrow(() => assertTranscriptMatch(a, b));
    assert.throws(() => assertTranscriptMatch(a, transcriptHash({ capabilities: ["a"] }, { capabilities: ["c"] })), DowngradeAttackError);
  });
});

describe("protocol integrity", () => {
  const session = { handshakeId: "h1", initiator: "a", responder: "b", state: HandshakeState.WAITING, createdAt: "2020-01-01", updatedAt: "2020-01-02" };
  const req = () => buildRequest({ handshakeId: "h1", initiator: "a", responder: "b", initiatorDevice: "d", version: "1.0" });

  it("validates headers, rejecting malformed", () => {
    assert.doesNotThrow(() => validateHeaders(req()));
    const bad = req();
    delete bad.nonce;
    assert.throws(() => validateHeaders(bad), ProtocolIntegrityError);
  });

  it("enforces message ordering per state", () => {
    assert.doesNotThrow(() => validateOrdering(req(), session));
    const accept = buildAccept({ handshakeId: "h1", responder: "b", initiator: "a", responderDevice: "d", version: "1.0" });
    assert.throws(() => validateOrdering(accept, { ...session, state: HandshakeState.COMPLETED }), ProtocolIntegrityError);
    assert.throws(() => validateOrdering(req(), { ...session, handshakeId: "other" }), ProtocolIntegrityError);
  });

  it("validates transitions + session metadata", () => {
    assert.doesNotThrow(() => validateTransition(HandshakeState.WAITING, HandshakeState.NEGOTIATING));
    assert.throws(() => validateTransition(HandshakeState.COMPLETED, HandshakeState.WAITING), ProtocolIntegrityError);
    assert.throws(() => validateSessionMetadata({ ...session, initiator: "x", responder: "x" }), ProtocolIntegrityError);
    assert.throws(() => validateSessionMetadata({ handshakeId: "h" }), ProtocolIntegrityError);
  });

  it("transcript accumulator is chained + order-sensitive", () => {
    const t1 = new TranscriptAccumulator("h1");
    const a = req();
    const b = buildAccept({ handshakeId: "h1", responder: "b", initiator: "a", responderDevice: "d", version: "1.0" });
    t1.append(a);
    t1.append(b);
    const t2 = new TranscriptAccumulator("h1");
    t2.append(b);
    t2.append(a);
    assert.equal(t1.length, 2);
    assert.notEqual(t1.digest, t2.digest);
    assert.equal(t1.matches(t1.digest), true);
  });

  it("verifyInboundMessage runs the full chain", () => {
    const t = new TranscriptAccumulator("h1");
    assert.doesNotThrow(() => verifyInboundMessage(req(), session, { transcript: t }));
    assert.equal(t.length, 1);
  });
});

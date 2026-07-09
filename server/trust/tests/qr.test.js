import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildQrPayload,
  serializeQrPayload,
  deserializeQrPayload,
  validateQrPayload,
  QR_PAYLOAD_TYPE,
} from "../qr/qrPayload.js";
import { InvalidQrPayloadError } from "../errors.js";
import { makeIdentity } from "./helpers.js";

function payloadFor(userId) {
  const id = makeIdentity(userId);
  return buildQrPayload({
    subjectUserId: id.userId,
    identityId: id.identityId,
    publicKey: id.publicKey,
    algorithm: id.algorithm,
    fingerprint: id.fingerprint,
  });
}

describe("QR verification payload", () => {
  it("serialize/deserialize round-trips and validates", () => {
    const payload = payloadFor("alice");
    const wire = serializeQrPayload(payload);
    const back = deserializeQrPayload(wire);
    assert.equal(back.type, QR_PAYLOAD_TYPE);
    assert.equal(back.subjectUserId, "alice");
    assert.equal(back.checksum, payload.checksum);
  });

  it("detects a tampered public key (checksum mismatch)", () => {
    const payload = payloadFor("alice");
    const other = makeIdentity("mallory");
    const tampered = { ...payload, publicKey: other.publicKey }; // checksum no longer matches
    assert.throws(() => validateQrPayload(tampered), InvalidQrPayloadError);
  });

  it("detects a fingerprint that does not match the key (recomputed checksum)", () => {
    const payload = payloadFor("alice");
    // Rebuild a self-consistent-looking payload but with a wrong fingerprint:
    const bad = buildQrPayload({ ...payload, fingerprint: "0".repeat(64) });
    assert.throws(() => validateQrPayload(bad), InvalidQrPayloadError);
  });

  it("rejects wrong type / version / malformed base64url", () => {
    const payload = payloadFor("alice");
    assert.throws(() => validateQrPayload({ ...payload, type: "x" }), InvalidQrPayloadError);
    assert.throws(() => validateQrPayload({ ...payload, v: 99 }), InvalidQrPayloadError);
    assert.throws(() => deserializeQrPayload("!!!not-base64!!!"), InvalidQrPayloadError);
  });
});

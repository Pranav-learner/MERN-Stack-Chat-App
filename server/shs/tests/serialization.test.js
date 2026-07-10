import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRequest,
  buildAccept,
  buildReject,
  buildComplete,
  buildError,
  assertEnvelope,
} from "../messages/messages.js";
import {
  toJson,
  fromJson,
  toBinary,
  fromBinary,
  toCompact,
  fromCompact,
  serialize,
  deserialize,
  crc32,
  SerializationFormat,
} from "../serializers/serializer.js";
import { MessageType } from "../types.js";
import { MessageSerializationError, HandshakeValidationError } from "../errors.js";

const sampleRequest = () =>
  buildRequest({
    handshakeId: "hs-1",
    initiator: "alice",
    responder: "bob",
    initiatorDevice: "dev-a",
    responderDevice: "dev-b",
    version: "1.0",
    capabilities: ["handshake.resume"],
    metadata: { note: "hi" },
  });

/** Normalize a message the way JSON does (drops `undefined` keys) for comparison. */
const norm = (m) => JSON.parse(JSON.stringify(m));

describe("handshake messages", () => {
  it("builds a well-formed request envelope", () => {
    const m = sampleRequest();
    assert.equal(m.type, MessageType.REQUEST);
    assert.equal(m.handshakeId, "hs-1");
    assert.equal(m.from, "alice");
    assert.equal(m.to, "bob");
    assert.equal(m.minVersion, "1.0");
    assert.match(m.nonce, /^[0-9a-f]{32}$/);
    assert.ok(typeof m.messageId === "string" && m.messageId.length > 0);
    assert.deepEqual(m.payload.capabilities, ["handshake.resume"]);
  });

  it("each builder sets its own type", () => {
    assert.equal(buildAccept({ handshakeId: "h", responder: "b", initiator: "a", responderDevice: "d", version: "1.0" }).type, MessageType.ACCEPT);
    assert.equal(buildReject({ handshakeId: "h", responder: "b", initiator: "a", reason: "no" }).type, MessageType.REJECT);
    assert.equal(buildComplete({ handshakeId: "h", from: "a" }).type, MessageType.COMPLETE);
    assert.equal(buildError({ code: "X", message: "y" }).type, MessageType.ERROR);
  });

  it("assertEnvelope rejects non-messages", () => {
    assert.throws(() => assertEnvelope(null), HandshakeValidationError);
    assert.throws(() => assertEnvelope({ type: "nope" }), HandshakeValidationError);
    assert.throws(() => assertEnvelope({ type: MessageType.REQUEST }), HandshakeValidationError); // no messageId
  });
});

describe("serialization", () => {
  it("JSON round-trips", () => {
    const m = sampleRequest();
    const json = toJson(m);
    const back = fromJson(json);
    assert.deepEqual(back, norm(m));
  });

  it("binary round-trips with a framed header", () => {
    const m = sampleRequest();
    const buf = toBinary(m);
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.toString("ascii", 0, 4), "SHS1");
    assert.deepEqual(fromBinary(buf), norm(m));
  });

  it("compact (base64url) round-trips", () => {
    const m = sampleRequest();
    const s = toCompact(m);
    assert.match(s, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(fromCompact(s), norm(m));
  });

  it("format-agnostic facade round-trips all three", () => {
    const m = sampleRequest();
    for (const fmt of Object.values(SerializationFormat)) {
      assert.deepEqual(deserialize(serialize(m, fmt), fmt), norm(m), `format ${fmt}`);
    }
  });

  it("detects a corrupted binary body (checksum mismatch)", () => {
    const buf = toBinary(sampleRequest());
    buf[buf.length - 2] ^= 0xff; // flip a bit in the body
    assert.throws(() => fromBinary(buf), MessageSerializationError);
  });

  it("rejects a frame with bad magic", () => {
    const buf = toBinary(sampleRequest());
    buf.write("XXXX", 0, "ascii");
    assert.throws(() => fromBinary(buf), MessageSerializationError);
  });

  it("rejects a truncated frame", () => {
    const buf = toBinary(sampleRequest());
    assert.throws(() => fromBinary(buf.subarray(0, buf.length - 3)), MessageSerializationError);
  });

  it("rejects malformed JSON", () => {
    assert.throws(() => fromJson("{not json"), MessageSerializationError);
  });

  it("crc32 is stable and order-sensitive", () => {
    assert.equal(crc32(Buffer.from("abc")), crc32(Buffer.from("abc")));
    assert.notEqual(crc32(Buffer.from("abc")), crc32(Buffer.from("acb")));
  });
});

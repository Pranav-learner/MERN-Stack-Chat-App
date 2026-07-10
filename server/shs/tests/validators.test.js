import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateMessage,
  validateVersionCompatibility,
  validateAgainstSession,
  validateParties,
  assertNotDuplicate,
  isExpired,
  assertNotExpired,
} from "../validators/validators.js";
import { buildRequest } from "../messages/messages.js";
import { createSession } from "../sessions/session.js";
import { HandshakeState } from "../types.js";
import {
  HandshakeValidationError,
  ProtocolVersionError,
  HandshakeExpiredError,
  DuplicateHandshakeError,
  UnknownPartyError,
} from "../errors.js";

const goodRequest = () =>
  buildRequest({
    handshakeId: "hs-1",
    initiator: "alice",
    responder: "bob",
    initiatorDevice: "dev-a",
    version: "1.0",
  });

describe("message validation", () => {
  it("accepts a well-formed message", () => {
    assert.doesNotThrow(() => validateMessage(goodRequest()));
  });

  it("rejects missing required fields", () => {
    const m = goodRequest();
    delete m.fromDevice;
    assert.throws(() => validateMessage(m), HandshakeValidationError);
  });

  it("rejects an invalid nonce/timestamp", () => {
    const m1 = goodRequest();
    m1.nonce = "zzz";
    assert.throws(() => validateMessage(m1), HandshakeValidationError);
    const m2 = goodRequest();
    m2.timestamp = "soon";
    assert.throws(() => validateMessage(m2), HandshakeValidationError);
  });

  it("rejects an unsupported version", () => {
    const m = goodRequest();
    m.version = "9.9";
    assert.throws(() => validateMessage(m), ProtocolVersionError);
    assert.doesNotThrow(() => validateMessage(m, { allowUnsupportedVersion: true }));
  });

  it("version compatibility guard", () => {
    assert.doesNotThrow(() => validateVersionCompatibility("1.0", "1.0"));
    assert.throws(() => validateVersionCompatibility("1.0", "2.0"), ProtocolVersionError);
  });
});

describe("session validation", () => {
  const now = 1_700_000_000_000;
  const mkSession = (over = {}) =>
    createSession({
      initiator: "alice",
      responder: "bob",
      initiatorDevice: "dev-a",
      ttlMs: 1000,
      clock: () => now,
      idGenerator: () => "hs-1",
      ...over,
    });

  it("matches a message to its session", () => {
    const s = mkSession();
    assert.doesNotThrow(() => validateAgainstSession({ handshakeId: "hs-1" }, s, { now }));
    assert.throws(() => validateAgainstSession({ handshakeId: "other" }, s, { now }), HandshakeValidationError);
    assert.throws(() => validateAgainstSession({ handshakeId: "hs-1" }, null, { now }), HandshakeValidationError);
  });

  it("detects expiry (active only)", () => {
    const s = mkSession();
    assert.equal(isExpired(s, now), false);
    assert.equal(isExpired(s, now + 2000), true);
    assert.throws(() => assertNotExpired(s, now + 2000), HandshakeExpiredError);
    // a terminal session is never "expired" for the purpose of the guard
    const terminal = mkSession();
    terminal.state = HandshakeState.COMPLETED;
    assert.doesNotThrow(() => assertNotExpired(terminal, now + 2000));
  });
});

describe("party validation", () => {
  it("requires two distinct parties", async () => {
    await assert.rejects(() => validateParties({ initiator: "a", responder: "" }), HandshakeValidationError);
    await assert.rejects(() => validateParties({ initiator: "a", responder: "a" }), HandshakeValidationError);
    await assert.doesNotReject(() => validateParties({ initiator: "a", responder: "b" }));
  });

  it("uses identity/device lookups when provided", async () => {
    const identityLookup = async (u) => (u === "ghost" ? null : { userId: u });
    const deviceLookup = async (_u, d) => (d === "bad" ? null : { deviceId: d });
    await assert.rejects(
      () => validateParties({ initiator: "ghost", responder: "b" }, { identityLookup }),
      UnknownPartyError,
    );
    await assert.rejects(
      () => validateParties({ initiator: "a", responder: "b", initiatorDevice: "bad" }, { identityLookup, deviceLookup }),
      UnknownPartyError,
    );
    await assert.doesNotReject(() =>
      validateParties({ initiator: "a", responder: "b", initiatorDevice: "ok" }, { identityLookup, deviceLookup }),
    );
  });
});

describe("duplicate guard", () => {
  it("throws on a seen messageId", () => {
    const seen = new Set(["m-1"]);
    assert.throws(() => assertNotDuplicate({ messageId: "m-1" }, seen), DuplicateHandshakeError);
    assert.doesNotThrow(() => assertNotDuplicate({ messageId: "m-2" }, seen));
  });
});

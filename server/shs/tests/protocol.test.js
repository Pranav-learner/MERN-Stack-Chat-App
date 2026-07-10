import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_VERSION,
  MINIMUM_VERSION,
  parseVersion,
  isSupported,
  isCompatible,
  compare,
  negotiateVersion,
  featuresForVersion,
  versionDescriptor,
} from "../protocol/version.js";
import { negotiate, canNegotiate } from "../negotiation/negotiation.js";
import { ProtocolVersionError, NegotiationError } from "../errors.js";

describe("protocol version management", () => {
  it("parses and rejects malformed versions", () => {
    assert.deepEqual(parseVersion("1.0"), { major: 1, minor: 0 });
    assert.deepEqual(parseVersion("2.5"), { major: 2, minor: 5 });
    assert.throws(() => parseVersion("1"), ProtocolVersionError);
    assert.throws(() => parseVersion("x.y"), ProtocolVersionError);
    assert.throws(() => parseVersion(""), ProtocolVersionError);
  });

  it("knows what it supports", () => {
    assert.equal(isSupported(CURRENT_VERSION), true);
    assert.equal(isSupported("9.9"), false);
  });

  it("compares versions", () => {
    assert.equal(compare("1.0", "1.0"), 0);
    assert.equal(compare("1.0", "1.2"), -1);
    assert.equal(compare("2.0", "1.9"), 1);
  });

  it("compatibility requires a shared major at/above the minimum", () => {
    assert.equal(isCompatible("1.0", "1.0"), true);
    assert.equal(isCompatible("1.0", "1.5"), true); // same major
    assert.equal(isCompatible("1.0", "2.0"), false); // major mismatch
    assert.equal(isCompatible("0.9", "1.0"), false); // below minimum
    assert.equal(isCompatible("bad", "1.0"), false);
  });

  it("negotiates the lower minor within a major", () => {
    assert.equal(negotiateVersion("1.0", "1.0"), "1.0");
    assert.equal(negotiateVersion("1.5", "1.2"), "1.2");
    assert.equal(negotiateVersion("1.2", "1.5"), "1.2");
    assert.throws(() => negotiateVersion("1.0", "2.0"), ProtocolVersionError);
  });

  it("exposes version features + a descriptor", () => {
    assert.ok(featuresForVersion(CURRENT_VERSION).includes("handshake.lifecycle"));
    assert.deepEqual(featuresForVersion("9.9"), []);
    const d = versionDescriptor();
    assert.equal(d.current, CURRENT_VERSION);
    assert.equal(d.minimum, MINIMUM_VERSION);
    assert.ok(Array.isArray(d.supported));
    assert.ok(d.features.length > 0);
  });
});

describe("capability negotiation", () => {
  it("intersects capabilities valid for the agreed version", () => {
    const r = negotiate(
      { version: "1.0", capabilities: ["handshake.resume", "handshake.retry", "bogus.feature"] },
      { version: "1.0", capabilities: ["handshake.resume", "handshake.retry"] },
    );
    assert.equal(r.version, "1.0");
    assert.deepEqual(r.capabilities, ["handshake.resume", "handshake.retry"]);
    // bogus.feature isn't a real 1.0 feature and one side lacked it → rejected
    assert.ok(r.rejected.includes("bogus.feature"));
  });

  it("drops capabilities only one side advertises", () => {
    const r = negotiate(
      { version: "1.0", capabilities: ["handshake.resume", "handshake.retry"] },
      { version: "1.0", capabilities: ["handshake.resume"] },
    );
    assert.deepEqual(r.capabilities, ["handshake.resume"]);
    assert.ok(r.rejected.includes("handshake.retry"));
  });

  it("fails when a required capability is unmet", () => {
    assert.throws(
      () =>
        negotiate(
          { version: "1.0", capabilities: ["handshake.resume"] },
          { version: "1.0", capabilities: [] },
          { required: ["handshake.resume"] },
        ),
      NegotiationError,
    );
    assert.equal(
      canNegotiate(
        { version: "1.0", capabilities: ["handshake.resume"] },
        { version: "1.0", capabilities: ["handshake.resume"] },
        { required: ["handshake.resume"] },
      ),
      true,
    );
  });

  it("propagates version incompatibility", () => {
    assert.throws(() => negotiate({ version: "1.0" }, { version: "2.0" }), ProtocolVersionError);
    assert.equal(canNegotiate({ version: "1.0" }, { version: "2.0" }), false);
  });
});

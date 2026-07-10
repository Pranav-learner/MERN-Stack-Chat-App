import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { securityAudit, ControlStatus } from "../audit/securityAudit.js";
import { PROTOCOL_MANIFEST, EXTENSION_POINTS, manifestHash, assertFrozen } from "../protocol/freeze.js";
import { ALL_MESSAGE_TYPES } from "../../types.js";
import { SUPPORTED_ALGORITHMS } from "../../key-agreement/types.js";

describe("security audit", () => {
  it("reports all controls with a summary + assumptions", () => {
    const audit = securityAudit();
    assert.ok(audit.controls.length >= 12);
    assert.ok(audit.assumptions.length > 0);
    // no control is "missing"
    assert.equal(audit.controls.some((c) => c.status === ControlStatus.MISSING), false);
    // required controls present
    for (const name of ["Replay resistance", "Downgrade resistance", "Key lifecycle", "Session isolation"]) {
      assert.ok(audit.controls.some((c) => c.control === name), name);
    }
    // future-scoped controls are labelled
    assert.ok(audit.controls.some((c) => c.control === "Forward secrecy" && c.status === ControlStatus.FUTURE));
  });

  it("authenticated key exchange flips MITM resistance to implemented", () => {
    const withoutAuth = securityAudit({ authenticatedKeyExchange: false }).controls.find((c) => c.control === "MITM resistance");
    const withAuth = securityAudit({ authenticatedKeyExchange: true }).controls.find((c) => c.control === "MITM resistance");
    assert.equal(withoutAuth.status, ControlStatus.PARTIAL);
    assert.equal(withAuth.status, ControlStatus.IMPLEMENTED);
  });
});

describe("protocol freeze", () => {
  it("manifest reflects the live protocol surface", () => {
    assert.deepEqual(PROTOCOL_MANIFEST.messageTypes, [...ALL_MESSAGE_TYPES]);
    assert.deepEqual(PROTOCOL_MANIFEST.keyAgreementAlgorithms, [...SUPPORTED_ALGORITHMS]);
    assert.equal(PROTOCOL_MANIFEST.version.current, "1.0");
    assert.ok(PROTOCOL_MANIFEST.handshakeStates.includes("cryptographically_complete"));
    assert.ok(PROTOCOL_MANIFEST.sessionStates.includes("active"));
    assert.equal(PROTOCOL_MANIFEST.sessionModel.secretFields.startsWith("NONE"), true);
  });

  it("manifest hash is stable + drift is detected", () => {
    assert.equal(manifestHash(), manifestHash());
    assert.match(manifestHash(), /^[0-9a-f]{64}$/);
    assert.equal(assertFrozen(PROTOCOL_MANIFEST), true);
    assert.throws(() => assertFrozen({ ...PROTOCOL_MANIFEST, protocol: "OTHER" }), /drift/);
  });

  it("documents extension points for Layer 5", () => {
    assert.ok(EXTENSION_POINTS.length >= 6);
    for (const ep of EXTENSION_POINTS) {
      assert.ok(typeof ep.point === "string" && typeof ep.how === "string");
    }
    assert.ok(EXTENSION_POINTS.some((e) => /ratchet|forward secrecy/i.test(e.point)));
    assert.ok(EXTENSION_POINTS.some((e) => /session keys/i.test(e.point)));
  });
});

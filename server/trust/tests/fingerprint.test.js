import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFingerprint, verifyFingerprint, fingerprintsEqual, FINGERPRINT_VERSION } from "../fingerprints/fingerprint.js";
import { makeIdentity } from "./helpers.js";

describe("trust fingerprints", () => {
  it("builds machine / compact / human / version / metadata", () => {
    const id = makeIdentity("alice");
    const fp = buildFingerprint(id.raw, { algorithm: "ed25519", createdAt: "2026-01-01T00:00:00.000Z" });
    assert.match(fp.machine, /^[0-9a-f]{64}$/);
    assert.equal(fp.machine, id.fingerprint); // matches Sprint 1 spec
    assert.equal(fp.compact.length, 16);
    assert.ok(fp.human.includes(" "));
    assert.equal(fp.version, FINGERPRINT_VERSION);
    assert.equal(fp.metadata.algorithm, "ed25519");
    assert.equal(fp.metadata.createdAt, "2026-01-01T00:00:00.000Z");
  });

  it("is stable for the same key and distinct across keys", () => {
    const a = makeIdentity("a");
    assert.equal(buildFingerprint(a.raw).machine, buildFingerprint(a.raw).machine);
    assert.notEqual(buildFingerprint(a.raw).machine, buildFingerprint(makeIdentity("b").raw).machine);
  });

  it("verifyFingerprint + fingerprintsEqual", () => {
    const a = makeIdentity("a");
    assert.equal(verifyFingerprint(a.raw, a.fingerprint), true);
    assert.equal(verifyFingerprint(a.raw, "0".repeat(64)), false);
    assert.equal(fingerprintsEqual(a.fingerprint, a.fingerprint.toUpperCase()), true);
    assert.equal(fingerprintsEqual(a.fingerprint, "x"), false);
  });
});

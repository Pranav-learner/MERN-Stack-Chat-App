import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeFingerprint,
  fingerprintBinary,
  toHumanReadable,
  toNumericCode,
  fingerprintFormats,
  verifyFingerprint,
} from "../fingerprints/fingerprint.js";
import { makeIdentityKey } from "./helpers.js";

describe("fingerprint", () => {
  it("computes a deterministic 64-char hex fingerprint", () => {
    const { raw } = makeIdentityKey();
    const fp = computeFingerprint(raw);
    assert.match(fp, /^[0-9a-f]{64}$/);
    assert.equal(fp, computeFingerprint(raw)); // deterministic
  });

  it("is stable for the same public key (stable across devices for an identity)", () => {
    const { raw } = makeIdentityKey();
    assert.equal(computeFingerprint(raw), computeFingerprint(Buffer.from(raw)));
  });

  it("differs for different keys", () => {
    assert.notEqual(computeFingerprint(makeIdentityKey().raw), computeFingerprint(makeIdentityKey().raw));
  });

  it("binary form is the 32-byte digest", () => {
    assert.equal(fingerprintBinary(makeIdentityKey().raw).length, 32);
  });

  it("human format groups hex; numeric format is 8 groups of 5 digits", () => {
    const fp = computeFingerprint(makeIdentityKey().raw);
    const human = toHumanReadable(fp);
    assert.ok(human.includes(" "));
    assert.equal(human.replace(/ /g, ""), fp);
    const numeric = toNumericCode(fp);
    assert.match(numeric, /^(\d{5} ){7}\d{5}$/);
  });

  it("fingerprintFormats returns all three formats", () => {
    const fp = computeFingerprint(makeIdentityKey().raw);
    const formats = fingerprintFormats(fp);
    assert.equal(formats.machine, fp);
    assert.ok(formats.human && formats.numeric);
  });

  it("verifyFingerprint accepts the correct fp and rejects wrong/malformed", () => {
    const { raw, fingerprint } = makeIdentityKey();
    assert.equal(verifyFingerprint(raw, fingerprint), true);
    assert.equal(verifyFingerprint(raw, "0".repeat(64)), false);
    assert.equal(verifyFingerprint(raw, "not-hex"), false);
    assert.equal(verifyFingerprint(raw, ""), false);
  });
});

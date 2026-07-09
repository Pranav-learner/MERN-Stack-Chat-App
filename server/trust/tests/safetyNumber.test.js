import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeSafetyNumber,
  formatSafetyNumber,
  normalizeSafetyNumber,
  isValidSafetyNumber,
} from "../safety-number/safetyNumber.js";
import { makeIdentity, FAST_SN } from "./helpers.js";

const party = (id) => {
  const identity = makeIdentity(id);
  return { publicKey: identity.raw, identifier: identity.userId };
};

describe("safety numbers", () => {
  it("is deterministic and 60 digits", () => {
    const a = party("alice");
    const b = party("bob");
    const sn1 = computeSafetyNumber(a, b, FAST_SN);
    const sn2 = computeSafetyNumber(a, b, FAST_SN);
    assert.equal(sn1.value, sn2.value);
    assert.match(sn1.value, /^\d{60}$/);
  });

  it("is symmetric: SN(A,B) === SN(B,A)", () => {
    const a = party("alice");
    const b = party("bob");
    assert.equal(computeSafetyNumber(a, b, FAST_SN).value, computeSafetyNumber(b, a, FAST_SN).value);
  });

  it("differs for different identities", () => {
    const a = party("alice");
    const b = party("bob");
    const c = party("carol");
    assert.notEqual(computeSafetyNumber(a, b, FAST_SN).value, computeSafetyNumber(a, c, FAST_SN).value);
  });

  it("changes when a party's key changes", () => {
    const a = party("alice");
    const b1 = party("bob");
    const b2 = party("bob"); // fresh key, same identifier
    assert.notEqual(computeSafetyNumber(a, b1, FAST_SN).value, computeSafetyNumber(a, b2, FAST_SN).value);
  });

  it("formats into groups of 5 and validates/normalizes", () => {
    const sn = computeSafetyNumber(party("a"), party("b"), FAST_SN);
    assert.match(sn.formatted, /^(\d{5} ){11}\d{5}$/);
    assert.equal(normalizeSafetyNumber(sn.formatted), sn.value);
    assert.equal(isValidSafetyNumber(sn.formatted), true);
    assert.equal(isValidSafetyNumber("123"), false);
  });
});

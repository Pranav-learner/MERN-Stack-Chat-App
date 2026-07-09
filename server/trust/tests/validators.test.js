import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canTransition, assertTransition, assertOwnership, validateVerifyRequest } from "../validators/trustValidators.js";
import { TrustState } from "../types.js";
import { InvalidTrustTransitionError, VerificationOwnershipError, TrustValidationError } from "../errors.js";

describe("trust validators", () => {
  it("allows legal transitions and rejects illegal ones", () => {
    assert.equal(canTransition(TrustState.UNKNOWN, TrustState.VERIFIED), true);
    assert.equal(canTransition(TrustState.VERIFIED, TrustState.TRUSTED), true);
    assert.equal(canTransition(TrustState.VERIFIED, TrustState.CHANGED), true);
    assert.equal(canTransition(TrustState.REVOKED, TrustState.TRUSTED), false);
    assert.equal(canTransition(TrustState.COMPROMISED, TrustState.VERIFIED), false);
    assert.throws(() => assertTransition(TrustState.REVOKED, TrustState.TRUSTED), InvalidTrustTransitionError);
  });

  it("assertOwnership guards the verifier", () => {
    assert.doesNotThrow(() => assertOwnership({ verifierUser: "u1" }, "u1"));
    assert.throws(() => assertOwnership({ verifierUser: "u1" }, "u2"), VerificationOwnershipError);
  });

  it("validateVerifyRequest rejects self-verification and missing ids", () => {
    assert.doesNotThrow(() => validateVerifyRequest({ verifierUser: "a", subjectUser: "b" }));
    assert.throws(() => validateVerifyRequest({ verifierUser: "a", subjectUser: "a" }), TrustValidationError);
    assert.throws(() => validateVerifyRequest({ verifierUser: "a" }), TrustValidationError);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canTransition,
  assertTransition,
  effectiveStatus,
  isTrusted,
  canEstablishSession,
  DEFAULT_INACTIVITY_MS,
} from "../policies/trustPolicy.js";
import { RegistrationPolicy } from "../policies/registrationPolicy.js";
import { TrustStatus } from "../types.js";
import { InvalidTrustTransitionError, RegistrationPolicyError, DeviceValidationError } from "../errors.js";

describe("trustPolicy — state machine", () => {
  it("allows legal transitions and rejects illegal ones", () => {
    assert.equal(canTransition(TrustStatus.PENDING, TrustStatus.TRUSTED), true);
    assert.equal(canTransition(TrustStatus.TRUSTED, TrustStatus.REVOKED), true);
    assert.equal(canTransition(TrustStatus.TRUSTED, TrustStatus.INACTIVE), true);
    assert.equal(canTransition(TrustStatus.INACTIVE, TrustStatus.TRUSTED), true);
    assert.equal(canTransition(TrustStatus.BLOCKED, TrustStatus.TRUSTED), true);
    // REVOKED is terminal
    assert.equal(canTransition(TrustStatus.REVOKED, TrustStatus.TRUSTED), false);
    // PENDING cannot go straight to INACTIVE
    assert.equal(canTransition(TrustStatus.PENDING, TrustStatus.INACTIVE), false);
    // idempotent no-op allowed
    assert.equal(canTransition(TrustStatus.TRUSTED, TrustStatus.TRUSTED), true);
  });

  it("assertTransition throws on illegal transitions", () => {
    assert.throws(() => assertTransition(TrustStatus.REVOKED, TrustStatus.TRUSTED), InvalidTrustTransitionError);
    assert.doesNotThrow(() => assertTransition(TrustStatus.PENDING, TrustStatus.TRUSTED));
  });
});

describe("trustPolicy — expiry & session decision", () => {
  const now = 1_000_000_000_000;

  it("a trusted device idle beyond the window evaluates to expired", () => {
    const fresh = { trustStatus: TrustStatus.TRUSTED, lastActive: now - 1000 };
    const stale = { trustStatus: TrustStatus.TRUSTED, lastActive: now - DEFAULT_INACTIVITY_MS - 1 };
    assert.equal(effectiveStatus(fresh, { now }), TrustStatus.TRUSTED);
    assert.equal(effectiveStatus(stale, { now }), TrustStatus.EXPIRED);
    assert.equal(isTrusted(stale, { now }), false);
  });

  it("non-trusted stored statuses pass through unchanged", () => {
    for (const s of [TrustStatus.PENDING, TrustStatus.REVOKED, TrustStatus.BLOCKED, TrustStatus.INACTIVE]) {
      assert.equal(effectiveStatus({ trustStatus: s, lastActive: now }, { now }), s);
    }
  });

  it("canEstablishSession gates on effective trust", () => {
    assert.deepEqual(canEstablishSession({ trustStatus: TrustStatus.TRUSTED, lastActive: now }, { now }), {
      ok: true,
      status: TrustStatus.TRUSTED,
    });
    assert.equal(canEstablishSession({ trustStatus: TrustStatus.REVOKED }, { now }).ok, false);
    assert.equal(canEstablishSession(null).status, TrustStatus.UNKNOWN);
  });
});

describe("registrationPolicy", () => {
  it("auto-trusts the first device, pends the rest", () => {
    const policy = new RegistrationPolicy();
    assert.equal(policy.initialTrustStatus(true), TrustStatus.TRUSTED);
    assert.equal(policy.initialTrustStatus(false), TrustStatus.PENDING);
  });

  it("enforces the device limit", () => {
    const policy = new RegistrationPolicy({ maxDevicesPerUser: 2 });
    assert.doesNotThrow(() => policy.assertCanRegister({ currentCount: 1 }));
    assert.throws(() => policy.assertCanRegister({ currentCount: 2 }), RegistrationPolicyError);
  });

  it("validates device names", () => {
    const policy = new RegistrationPolicy({ maxNameLength: 5 });
    assert.doesNotThrow(() => policy.validateName(undefined));
    assert.doesNotThrow(() => policy.validateName("abc"));
    assert.throws(() => policy.validateName("toolong"), DeviceValidationError);
    assert.throws(() => policy.validateName(""), DeviceValidationError);
  });
});

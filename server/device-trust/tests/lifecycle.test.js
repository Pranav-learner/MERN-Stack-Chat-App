import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planTransition } from "../lifecycle/deviceLifecycle.js";
import { DeviceAction, DeviceEventType, TrustStatus } from "../types.js";
import { InvalidTrustTransitionError, DeviceValidationError } from "../errors.js";

describe("deviceLifecycle.planTransition", () => {
  const now = 1_700_000_000_000;

  it("revoke sets revoked status, legacy status, revokedAt/reason, and event", () => {
    const { patch, event, targetStatus } = planTransition(
      { trustStatus: TrustStatus.TRUSTED },
      DeviceAction.REVOKE,
      { now, reason: "lost" },
    );
    assert.equal(targetStatus, TrustStatus.REVOKED);
    assert.equal(patch.trustStatus, TrustStatus.REVOKED);
    assert.equal(patch.status, "revoked");
    assert.equal(patch.revokedReason, "lost");
    assert.ok(patch.revokedAt);
    assert.equal(event, DeviceEventType.REVOKED);
  });

  it("deactivate records deactivatedAt; activate refreshes lastActive", () => {
    assert.ok(planTransition({ trustStatus: TrustStatus.TRUSTED }, DeviceAction.DEACTIVATE, { now }).patch.deactivatedAt);
    assert.ok(planTransition({ trustStatus: TrustStatus.INACTIVE }, DeviceAction.ACTIVATE, { now }).patch.lastActive);
  });

  it("keeps legacy status active for non-revoke/block transitions", () => {
    assert.equal(planTransition({ trustStatus: TrustStatus.PENDING }, DeviceAction.ACTIVATE, { now }).patch.status, "active");
    assert.equal(planTransition({ trustStatus: TrustStatus.TRUSTED }, DeviceAction.BLOCK, { now }).patch.status, "revoked");
  });

  it("rejects illegal transitions and unknown actions", () => {
    assert.throws(
      () => planTransition({ trustStatus: TrustStatus.REVOKED }, DeviceAction.ACTIVATE, { now }),
      InvalidTrustTransitionError,
    );
    assert.throws(() => planTransition({ trustStatus: TrustStatus.TRUSTED }, "nope", { now }), DeviceValidationError);
  });
});

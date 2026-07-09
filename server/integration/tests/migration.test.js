import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildStack, provision } from "./helpers.js";
import { reportIdentityAdoption } from "../../identity/migration/migration.js";

/**
 * Migration is client-driven (the server cannot generate private keys). These
 * tests model the automatic on-login provisioning path and confirm it is
 * backward compatible: an un-provisioned existing user has a working (if not
 * "ready") context, and becomes ready after provisioning — no data is touched.
 */
describe("migration & lifecycle integration", () => {
  let stack;
  beforeEach(() => {
    stack = buildStack();
  });

  it("an existing user starts un-provisioned, then becomes ready after auto-provision", async () => {
    // Before: legacy user, no identity yet.
    let ctx = await stack.service.loadContext("legacy-user");
    assert.equal(ctx.provisioned, false);
    assert.equal(ctx.ready, false);

    // Automatic provisioning on next login (client generates keys, registers public).
    const { deviceId } = await provision(stack, "legacy-user");
    stack.service.invalidate("legacy-user");

    ctx = await stack.service.loadContext("legacy-user", { deviceId });
    assert.equal(ctx.provisioned, true);
    assert.equal(ctx.ready, true);
  });

  it("adoption report (Sprint 1) surfaces users still missing an identity", async () => {
    await provision(stack, "user-1");
    const UserModel = { find: () => ({ lean: async () => [{ _id: "user-1", email: "a" }, { _id: "user-2", email: "b" }] }) };
    // reportIdentityAdoption needs the identity repository — reach it via the manager's repo.
    const report = await reportIdentityAdoption({
      UserModel,
      identities: { findByUser: (id) => stack.identityManager.getIdentityByUser(id) },
    });
    assert.equal(report.withoutIdentity, 1);
    assert.equal(report.missing[0].userId, "user-2");
  });

  it("lifecycle: device revoked → session invalidated", async () => {
    const { deviceId } = await provision(stack, "user-1");
    assert.equal((await stack.service.validateSession("user-1", deviceId)).valid, true);

    stack.service.invalidate("user-1");
    await stack.deviceManager.revoke("user-1", deviceId, "stolen");
    stack.service.invalidate("user-1");

    const check = await stack.service.validateSession("user-1", deviceId);
    assert.equal(check.valid, false);
    assert.equal(check.reason, "device-revoked");
  });
});

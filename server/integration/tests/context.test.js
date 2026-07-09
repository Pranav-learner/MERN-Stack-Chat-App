import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildStack, provision, makeKey } from "./helpers.js";

describe("IdentityContextService — Application Ready context", () => {
  let stack;
  beforeEach(() => {
    stack = buildStack();
  });

  it("existing (unprovisioned) user → not provisioned, not ready", async () => {
    const ctx = await stack.service.loadContext("user-1");
    assert.equal(ctx.provisioned, false);
    assert.equal(ctx.ready, false);
    assert.equal(ctx.identity, null);
    assert.equal(ctx.deviceCount, 0);
    assert.ok(ctx.warnings.some((w) => w.type === "not-provisioned"));
  });

  it("provisioned user with a trusted device → ready, session valid", async () => {
    const { deviceId } = await provision(stack, "user-1");
    const ctx = await stack.service.loadContext("user-1", { deviceId });
    assert.equal(ctx.provisioned, true);
    assert.equal(ctx.deviceCount, 1);
    assert.equal(ctx.currentDevice.deviceId, deviceId);
    assert.equal(ctx.currentDevice.isTrusted, true);
    assert.equal(ctx.sessionValid, true);
    assert.equal(ctx.ready, true);
    // identity fingerprint present; no private key leaks
    assert.match(ctx.identity.fingerprint.machine, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(ctx).match(/private|"d":/i));
  });

  it("device revoked → session invalid, not ready, warning", async () => {
    const { deviceId } = await provision(stack, "user-1");
    stack.service.invalidate("user-1"); // bust cache after mutation below
    await stack.deviceManager.revoke("user-1", deviceId, "lost");
    stack.service.invalidate("user-1");
    const ctx = await stack.service.loadContext("user-1", { deviceId });
    assert.equal(ctx.sessionValid, false);
    assert.equal(ctx.ready, false);
    assert.ok(ctx.warnings.some((w) => w.type === "device-untrusted"));
  });

  it("validateSession reports reasons", async () => {
    assert.deepEqual(await stack.service.validateSession("ghost"), { valid: false, reason: "no-identity" });
    const { deviceId } = await provision(stack, "user-1");
    assert.deepEqual(await stack.service.validateSession("user-1", deviceId), { valid: true });
    assert.deepEqual(await stack.service.validateSession("user-1", "dev_unknown0"), {
      valid: false,
      reason: "unknown-device",
    });
    stack.service.invalidate("user-1");
    await stack.deviceManager.revoke("user-1", deviceId);
    stack.service.invalidate("user-1");
    assert.equal((await stack.service.validateSession("user-1", deviceId)).valid, false);
  });

  it("verification summary + directory reflect verifications", async () => {
    await provision(stack, "alice");
    await provision(stack, "bob");
    await stack.trustManager.verifyIdentity("alice", "bob");
    await stack.trustManager.trustIdentity("alice", "bob");
    stack.service.invalidate("alice");
    const ctx = await stack.service.loadContext("alice");
    assert.equal(ctx.verification.total, 1);
    assert.equal(ctx.verification.trusted, 1);
    const dir = await stack.service.verificationDirectory("alice");
    assert.equal(dir.length, 1);
    assert.equal(dir[0].subjectUserId, "bob");
    assert.equal(dir[0].trustState, "trusted");
  });

  it("caches the base context (TTL) and busts on invalidate", async () => {
    const cached = buildStack({ cacheTtlMs: 60_000 });
    const { identity } = await provision(cached, "user-1");
    assert.equal((await cached.service.loadContext("user-1")).deviceCount, 1);

    // Add a SECOND device to the same identity WITHOUT invalidating the cache.
    const devKey = makeKey();
    await cached.deviceManager.register({
      userId: "user-1",
      identityId: identity.identityId,
      deviceId: "dev_second00",
      publicKey: devKey.publicKey,
      algorithm: "ed25519",
      fingerprint: devKey.fingerprint,
    });
    assert.equal((await cached.service.loadContext("user-1")).deviceCount, 1); // stale (cached)
    cached.service.invalidate("user-1");
    assert.equal((await cached.service.loadContext("user-1")).deviceCount, 2); // fresh
  });
});

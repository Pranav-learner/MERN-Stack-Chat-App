import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { IdentityManager } from "../manager/identityManager.js";
import { createInMemoryRepositories } from "../repository/inMemoryRepository.js";
import {
  DuplicateIdentityError,
  IdentityNotFoundError,
  IdentityValidationError,
  IdentityOwnershipError,
  DeviceNotFoundError,
} from "../errors.js";
import { makeIdentityKey, makeDeviceKey } from "./helpers.js";

describe("IdentityManager", () => {
  let repos;
  let manager;

  beforeEach(() => {
    repos = createInMemoryRepositories();
    manager = new IdentityManager(repos);
  });

  it("registers an identity + device and returns public DTOs (no private material)", async () => {
    const idKey = makeIdentityKey();
    const device = makeDeviceKey();
    const { identity, device: dev } = await manager.registerIdentity({
      userId: "user-1",
      ...idKey,
      device,
    });
    assert.equal(identity.userId, "user-1");
    assert.equal(identity.publicKey, idKey.publicKey);
    assert.equal(identity.algorithm, "ed25519");
    assert.equal(identity.fingerprint.machine, idKey.fingerprint);
    assert.equal(identity.status, "active");
    assert.equal(dev.deviceId, device.deviceId);

    // Private-key isolation: nothing private anywhere in the response.
    const serialized = JSON.stringify({ identity, dev });
    assert.ok(!/private|"d":|privateKey/i.test(serialized));
  });

  it("is idempotent for the same identity key; conflicts on a different key", async () => {
    const idKey = makeIdentityKey();
    await manager.registerIdentity({ userId: "user-1", ...idKey });
    // same key again → OK, same identity
    const again = await manager.registerIdentity({ userId: "user-1", ...idKey });
    assert.equal(again.identity.publicKey, idKey.publicKey);
    // different key for same user → conflict
    await assert.rejects(
      () => manager.registerIdentity({ userId: "user-1", ...makeIdentityKey() }),
      DuplicateIdentityError,
    );
  });

  it("rejects a fingerprint that does not match the public key", async () => {
    const idKey = makeIdentityKey();
    await assert.rejects(
      () => manager.registerIdentity({ userId: "user-1", ...idKey, fingerprint: "0".repeat(64) }),
      IdentityValidationError,
    );
  });

  it("getIdentityByUser returns null when absent; getPublicKey throws", async () => {
    assert.equal(await manager.getIdentityByUser("nobody"), null);
    await assert.rejects(() => manager.getPublicKey("nobody"), IdentityNotFoundError);
    await assert.rejects(() => manager.getFingerprint("nobody"), IdentityNotFoundError);
  });

  it("supports multiple devices under one identity", async () => {
    const idKey = makeIdentityKey();
    const reg = await manager.registerIdentity({ userId: "user-1", ...idKey });
    await manager.registerDevice({
      userId: "user-1",
      identityId: reg.identity.identityId,
      ...makeDeviceKey("device-11111111", "Laptop"),
    });
    await manager.registerDevice({
      userId: "user-1",
      identityId: reg.identity.identityId,
      ...makeDeviceKey("device-22222222", "Phone"),
    });
    const devices = await manager.listDevices("user-1");
    assert.equal(devices.length, 2);
    assert.deepEqual(devices.map((d) => d.name).sort(), ["Laptop", "Phone"]);
  });

  it("re-registering the same deviceId refreshes it (idempotent) and updates lastActive", async () => {
    const idKey = makeIdentityKey();
    const reg = await manager.registerIdentity({ userId: "user-1", ...idKey, device: makeDeviceKey() });
    const before = reg.device.lastActive;
    await new Promise((r) => setTimeout(r, 5));
    const refreshed = await manager.registerDevice({
      userId: "user-1",
      identityId: reg.identity.identityId,
      ...makeDeviceKey(),
    });
    assert.equal((await manager.listDevices("user-1")).length, 1);
    assert.notEqual(refreshed.lastActive, before);
  });

  it("enforces device ownership and reports unknown devices", async () => {
    const idKey = makeIdentityKey();
    await manager.registerIdentity({ userId: "user-1", ...idKey, device: makeDeviceKey("device-owned01") });
    // wrong owner
    await assert.rejects(() => manager.getDevice("user-2", "device-owned01"), IdentityOwnershipError);
    // unknown device
    await assert.rejects(() => manager.getDevice("user-1", "device-missing1"), DeviceNotFoundError);
  });

  it("registering a device under someone else's identity is rejected", async () => {
    const a = await manager.registerIdentity({ userId: "user-1", ...makeIdentityKey() });
    await assert.rejects(
      () =>
        manager.registerDevice({
          userId: "user-2",
          identityId: a.identity.identityId,
          ...makeDeviceKey("device-attacker"),
        }),
      IdentityOwnershipError,
    );
  });

  it("touchDevice updates lastActive", async () => {
    const idKey = makeIdentityKey();
    const reg = await manager.registerIdentity({ userId: "user-1", ...idKey, device: makeDeviceKey() });
    await new Promise((r) => setTimeout(r, 5));
    const touched = await manager.touchDevice("user-1", reg.device.deviceId);
    assert.notEqual(touched.lastActive, reg.device.lastActive);
  });

  it("validateIdentity detects missing identity and fingerprint corruption", async () => {
    assert.deepEqual(await manager.validateIdentity("nobody"), { ok: false, reason: "no-identity" });

    const idKey = makeIdentityKey();
    const reg = await manager.registerIdentity({ userId: "user-1", ...idKey });
    assert.deepEqual(await manager.validateIdentity("user-1"), { ok: true });

    // Corrupt the stored fingerprint directly via the repo.
    await repos.identities.update(reg.identity.identityId, { fingerprint: "0".repeat(64) });
    assert.deepEqual(await manager.validateIdentity("user-1"), {
      ok: false,
      reason: "fingerprint-mismatch",
    });
  });

  it("getPublicKey returns a distribution bundle", async () => {
    const idKey = makeIdentityKey();
    await manager.registerIdentity({ userId: "user-1", ...idKey });
    const bundle = await manager.getPublicKey("user-1");
    assert.equal(bundle.publicKey, idKey.publicKey);
    assert.equal(bundle.fingerprint.machine, idKey.fingerprint);
  });
});

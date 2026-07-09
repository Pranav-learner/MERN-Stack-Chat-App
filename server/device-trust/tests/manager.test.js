import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DeviceManager } from "../manager/deviceManager.js";
import { createInMemoryDeviceRepository } from "../repository/inMemoryRepository.js";
import { RegistrationPolicy } from "../policies/registrationPolicy.js";
import { DeviceEventBus } from "../events/deviceEvents.js";
import { TrustStatus, DeviceEventType } from "../types.js";
import {
  DeviceOwnershipError,
  DeviceNotFoundError,
  DeviceValidationError,
  InvalidTrustTransitionError,
  RegistrationPolicyError,
} from "../errors.js";
import { makeDeviceSubmission } from "./helpers.js";

describe("DeviceManager", () => {
  let repo;
  let events;
  let manager;

  beforeEach(() => {
    repo = createInMemoryDeviceRepository();
    events = new DeviceEventBus();
    manager = new DeviceManager({ devices: repo.devices, events });
  });

  const register = (userId, overrides) =>
    manager.register({ userId, ...makeDeviceSubmission({ identityId: `id-${userId}`, ...overrides }) });

  it("registers the first device as trusted, subsequent as pending", async () => {
    const d1 = await register("user-1");
    const d2 = await register("user-1");
    assert.equal(d1.trustStatus, TrustStatus.TRUSTED);
    assert.equal(d1.isTrusted, true);
    assert.equal(d2.trustStatus, TrustStatus.PENDING);
    assert.equal((await manager.listDevices("user-1")).length, 2);
  });

  it("emits DEVICE_REGISTERED with a public device payload (no private material)", async () => {
    const seen = [];
    events.on(DeviceEventType.REGISTERED, (e) => seen.push(e));
    const d = await register("user-1");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].deviceId, d.deviceId);
    assert.ok(!JSON.stringify(seen[0]).match(/private|"d":/i));
  });

  it("registration is idempotent on deviceId and refreshes metadata", async () => {
    const sub = makeDeviceSubmission({ identityId: "id-user-1", metadata: { a: 1 } });
    const first = await manager.register({ userId: "user-1", ...sub });
    const again = await manager.register({
      userId: "user-1",
      ...sub,
      name: "Renamed",
      metadata: { b: 2 },
    });
    assert.equal((await manager.listDevices("user-1")).length, 1);
    assert.equal(again.name, "Renamed");
    assert.deepEqual(again.metadata, { a: 1, b: 2 });
    assert.equal(again.trustStatus, first.trustStatus); // trust unchanged by refresh
  });

  it("rejects an invalid submission (fingerprint mismatch)", async () => {
    await assert.rejects(
      () => manager.register({ userId: "u", ...makeDeviceSubmission({ fingerprint: "0".repeat(64) }) }),
      DeviceValidationError,
    );
  });

  it("enforces the per-user device limit", async () => {
    manager = new DeviceManager({ devices: repo.devices, registrationPolicy: new RegistrationPolicy({ maxDevicesPerUser: 1 }) });
    await register("user-1");
    await assert.rejects(() => register("user-1"), RegistrationPolicyError);
  });

  describe("lifecycle", () => {
    it("activate: pending → trusted", async () => {
      await register("user-1"); // first (trusted)
      const pending = await register("user-1"); // second (pending)
      const activated = await manager.activate("user-1", pending.deviceId);
      assert.equal(activated.trustStatus, TrustStatus.TRUSTED);
    });

    it("deactivate then re-activate", async () => {
      const d = await register("user-1");
      assert.equal((await manager.deactivate("user-1", d.deviceId)).trustStatus, TrustStatus.INACTIVE);
      assert.equal((await manager.activate("user-1", d.deviceId)).trustStatus, TrustStatus.TRUSTED);
    });

    it("revoke is terminal (no transition out)", async () => {
      const d = await register("user-1");
      const revoked = await manager.revoke("user-1", d.deviceId, "lost device");
      assert.equal(revoked.trustStatus, TrustStatus.REVOKED);
      assert.equal(revoked.revokedReason, "lost device");
      await assert.rejects(() => manager.activate("user-1", d.deviceId), InvalidTrustTransitionError);
    });

    it("block then unblock", async () => {
      const d = await register("user-1");
      assert.equal((await manager.block("user-1", d.deviceId)).trustStatus, TrustStatus.BLOCKED);
      assert.equal((await manager.unblock("user-1", d.deviceId)).trustStatus, TrustStatus.TRUSTED);
    });

    it("emits the matching event for each transition", async () => {
      const types = [];
      events.on("*", (e) => types.push(e.type));
      const d = await register("user-1");
      await manager.deactivate("user-1", d.deviceId);
      await manager.activate("user-1", d.deviceId);
      await manager.revoke("user-1", d.deviceId);
      assert.deepEqual(types, [
        DeviceEventType.REGISTERED,
        DeviceEventType.DEACTIVATED,
        DeviceEventType.ACTIVATED,
        DeviceEventType.REVOKED,
      ]);
    });
  });

  describe("updates & queries", () => {
    it("rename and updateMetadata", async () => {
      const d = await register("user-1");
      assert.equal((await manager.rename("user-1", d.deviceId, "My Laptop")).name, "My Laptop");
      const meta = await manager.updateMetadata("user-1", d.deviceId, { color: "black" });
      assert.equal(meta.metadata.color, "black");
    });

    it("listTrusted and filterByStatus", async () => {
      await register("user-1"); // trusted
      const pending = await register("user-1"); // pending
      assert.equal((await manager.listTrusted("user-1")).length, 1);
      assert.equal((await manager.filterByStatus("user-1", TrustStatus.PENDING)).length, 1);
      assert.equal((await manager.filterByStatus("user-1", TrustStatus.PENDING))[0].deviceId, pending.deviceId);
    });

    it("getDevice and getFingerprint enforce ownership", async () => {
      const d = await register("user-1");
      assert.equal((await manager.getFingerprint("user-1", d.deviceId)).machine.length, 64);
      await assert.rejects(() => manager.getDevice("user-2", d.deviceId), DeviceOwnershipError);
      await assert.rejects(() => manager.getDevice("user-1", "dev_missing00000"), DeviceNotFoundError);
    });

    it("delete removes the device and emits DELETED", async () => {
      const seen = [];
      events.on(DeviceEventType.DELETED, (e) => seen.push(e));
      const d = await register("user-1");
      assert.deepEqual(await manager.delete("user-1", d.deviceId), { deleted: true });
      assert.equal(seen.length, 1);
      await assert.rejects(() => manager.getDevice("user-1", d.deviceId), DeviceNotFoundError);
    });
  });

  describe("trust evaluation (for future session layers)", () => {
    it("canEstablishSession only for trusted, owned, non-expired devices", async () => {
      const d = await register("user-1");
      assert.equal((await manager.canEstablishSession("user-1", d.deviceId)).ok, true);
      await manager.revoke("user-1", d.deviceId);
      assert.equal((await manager.canEstablishSession("user-1", d.deviceId)).ok, false);
      // cross-user
      assert.equal((await manager.canEstablishSession("user-2", d.deviceId)).ok, false);
      // unknown
      assert.equal((await manager.canEstablishSession("user-1", "dev_none00000000")).status, "unknown");
    });

    it("expiry is reflected in evaluateTrust via a controllable clock", async () => {
      let now = 1_000_000_000_000;
      const m = new DeviceManager({ devices: repo.devices, clock: () => now, inactivityMs: 1000 });
      const d = await m.register({ userId: "user-1", ...makeDeviceSubmission({ identityId: "id" }) });
      assert.equal((await m.evaluateTrust("user-1", d.deviceId)).status, TrustStatus.TRUSTED);
      now += 2000; // advance past the inactivity window
      assert.equal((await m.evaluateTrust("user-1", d.deviceId)).status, TrustStatus.EXPIRED);
    });
  });
});

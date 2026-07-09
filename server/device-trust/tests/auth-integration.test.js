import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DeviceManager } from "../manager/deviceManager.js";
import { createInMemoryDeviceRepository } from "../repository/inMemoryRepository.js";
import { TrustStatus } from "../types.js";
import { makeDeviceSubmission } from "./helpers.js";

/**
 * Models the additive login flow (JWT unchanged):
 *   Login → JWT → Load Device → Validate Device → Load Device Trust → Ready
 * The DeviceManager provides the "load device" + "validate" + "load trust" steps.
 */
describe("authentication integration (device trust, JWT unchanged)", () => {
  it("registers on first login, then loads trust on subsequent logins", async () => {
    const repo = createInMemoryDeviceRepository();
    const manager = new DeviceManager({ devices: repo.devices });
    const submission = makeDeviceSubmission({ identityId: "id-user-1" });

    // First login: device unknown → client registers → trusted (first device).
    let trust = await manager.getCurrentDeviceTrust("user-1", submission.deviceId);
    assert.equal(trust, null); // not yet known
    await manager.register({ userId: "user-1", ...submission });

    // Subsequent login: load device + trust, decide readiness.
    trust = await manager.getCurrentDeviceTrust("user-1", submission.deviceId);
    assert.ok(trust);
    assert.equal(trust.trustStatus, TrustStatus.TRUSTED);
    const decision = await manager.canEstablishSession("user-1", submission.deviceId);
    assert.equal(decision.ok, true); // "Ready"
  });

  it("a revoked device loads but is not session-ready", async () => {
    const repo = createInMemoryDeviceRepository();
    const manager = new DeviceManager({ devices: repo.devices });
    const submission = makeDeviceSubmission({ identityId: "id-user-1" });
    await manager.register({ userId: "user-1", ...submission });
    await manager.revoke("user-1", submission.deviceId, "compromised");

    const trust = await manager.getCurrentDeviceTrust("user-1", submission.deviceId);
    assert.equal(trust.trustStatus, TrustStatus.REVOKED);
    assert.equal((await manager.canEstablishSession("user-1", submission.deviceId)).ok, false);
  });

  it("another user's device never loads for the caller (ownership)", async () => {
    const repo = createInMemoryDeviceRepository();
    const manager = new DeviceManager({ devices: repo.devices });
    const submission = makeDeviceSubmission({ identityId: "id-user-1" });
    await manager.register({ userId: "user-1", ...submission });
    assert.equal(await manager.getCurrentDeviceTrust("user-2", submission.deviceId), null);
  });
});

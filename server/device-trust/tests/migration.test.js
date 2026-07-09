import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryDeviceRepository } from "../repository/inMemoryRepository.js";
import { backfillTrustStatus, trustStatusBreakdown } from "../migration/migration.js";
import { TrustStatus } from "../types.js";
import { makeDeviceSubmission } from "./helpers.js";

describe("device-trust migration / backward compatibility", () => {
  it("backfills trustStatus for Sprint 1 devices from legacy status", async () => {
    const repo = createInMemoryDeviceRepository();
    // Two "Sprint 1" devices without trustStatus (one active, one revoked).
    const legacyActive = { ...makeDeviceSubmission(), user: "u1", identityId: "i1", status: "active", lastActive: new Date(0).toISOString(), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    const legacyRevoked = { ...makeDeviceSubmission(), user: "u1", identityId: "i1", status: "revoked", lastActive: new Date(0).toISOString(), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    delete legacyActive.trustStatus;
    delete legacyRevoked.trustStatus;
    await repo.devices.create(legacyActive);
    await repo.devices.create(legacyRevoked);

    const result = await backfillTrustStatus(repo.devices, () => repo.devices.findByUser("u1"));
    assert.equal(result.scanned, 2);
    assert.equal(result.updated, 2);
    assert.equal((await repo.devices.findById(legacyActive.deviceId)).trustStatus, TrustStatus.TRUSTED);
    assert.equal((await repo.devices.findById(legacyRevoked.deviceId)).trustStatus, TrustStatus.REVOKED);

    // Idempotent: a second run updates nothing.
    const second = await backfillTrustStatus(repo.devices, () => repo.devices.findByUser("u1"));
    assert.equal(second.updated, 0);
  });

  it("trustStatusBreakdown summarizes a user's devices", async () => {
    const repo = createInMemoryDeviceRepository();
    for (const status of [TrustStatus.TRUSTED, TrustStatus.TRUSTED, TrustStatus.PENDING]) {
      await repo.devices.create({ ...makeDeviceSubmission(), user: "u1", identityId: "i1", trustStatus: status, status: "active" });
    }
    const breakdown = await trustStatusBreakdown(repo.devices, "u1");
    assert.deepEqual(breakdown, { trusted: 2, pending: 1 });
  });
});

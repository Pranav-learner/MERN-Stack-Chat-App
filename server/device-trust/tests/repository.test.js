import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryDeviceRepository } from "../repository/inMemoryRepository.js";
import { DuplicateDeviceError, DeviceNotFoundError } from "../errors.js";
import { TrustStatus } from "../types.js";
import { makeDeviceSubmission } from "./helpers.js";

describe("in-memory device repository", () => {
  let repo;
  beforeEach(() => {
    repo = createInMemoryDeviceRepository();
  });

  const record = (user, trustStatus = TrustStatus.TRUSTED, extra = {}) => {
    const s = makeDeviceSubmission();
    return {
      ...s,
      user,
      identityId: `id-${user}`,
      trustStatus,
      status: "active",
      lastActive: new Date(0).toISOString(),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      ...extra,
    };
  };

  it("create/find/update/delete", async () => {
    const r = record("user-1");
    await repo.devices.create(r);
    assert.equal((await repo.devices.findById(r.deviceId)).user, "user-1");
    assert.equal((await repo.devices.update(r.deviceId, { name: "X" })).name, "X");
    assert.equal(await repo.devices.delete(r.deviceId), true);
    assert.equal(await repo.devices.findById(r.deviceId), null);
  });

  it("rejects duplicate ids; update on missing throws", async () => {
    const r = record("user-1");
    await repo.devices.create(r);
    await assert.rejects(() => repo.devices.create(r), DuplicateDeviceError);
    await assert.rejects(() => repo.devices.update("nope", {}), DeviceNotFoundError);
  });

  it("filters by user, identity, and status; counts and lists trusted", async () => {
    await repo.devices.create(record("user-1", TrustStatus.TRUSTED));
    await repo.devices.create(record("user-1", TrustStatus.PENDING));
    await repo.devices.create(record("user-2", TrustStatus.TRUSTED));
    assert.equal(await repo.devices.countByUser("user-1"), 2);
    assert.equal((await repo.devices.findByUser("user-1")).length, 2);
    assert.equal((await repo.devices.findTrusted("user-1")).length, 1);
    assert.equal((await repo.devices.findByStatus("user-1", TrustStatus.PENDING)).length, 1);
    assert.equal((await repo.devices.findByIdentity("id-user-2")).length, 1);
  });

  it("isolates stored records from external mutation", async () => {
    const r = record("user-1");
    await repo.devices.create(r);
    r.name = "mutated";
    assert.notEqual((await repo.devices.findById(r.deviceId)).name, "mutated");
  });
});

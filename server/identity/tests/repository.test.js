import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryRepositories } from "../repository/inMemoryRepository.js";
import { DuplicateIdentityError, DuplicateDeviceError, IdentityNotFoundError } from "../errors.js";
import { makeIdentityKey } from "./helpers.js";

describe("in-memory repository", () => {
  let repos;
  beforeEach(() => {
    repos = createInMemoryRepositories();
  });

  const identityRecord = (user = "user-1") => {
    const k = makeIdentityKey();
    return {
      identityId: `id-${user}`,
      user,
      publicKey: k.publicKey,
      algorithm: "ed25519",
      fingerprint: k.fingerprint,
      version: 1,
      status: "active",
      metadata: {},
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
  };

  it("identity: create/find/update/delete", async () => {
    const rec = identityRecord();
    await repos.identities.create(rec);
    assert.equal((await repos.identities.findByUser("user-1")).identityId, "id-user-1");
    assert.equal((await repos.identities.findById("id-user-1")).user, "user-1");
    assert.ok(await repos.identities.findByFingerprint(rec.fingerprint));
    const updated = await repos.identities.update("id-user-1", { status: "revoked" });
    assert.equal(updated.status, "revoked");
    assert.equal(await repos.identities.delete("id-user-1"), true);
    assert.equal(await repos.identities.findByUser("user-1"), null);
  });

  it("identity: one per user; update on missing throws", async () => {
    await repos.identities.create(identityRecord("user-1"));
    await assert.rejects(() => repos.identities.create(identityRecord("user-1")), DuplicateIdentityError);
    await assert.rejects(() => repos.identities.update("nope", {}), IdentityNotFoundError);
  });

  it("isolates stored records from external mutation", async () => {
    const rec = identityRecord();
    await repos.identities.create(rec);
    rec.status = "mutated";
    assert.equal((await repos.identities.findByUser("user-1")).status, "active");
  });

  it("device: create/find/list/delete and duplicate id", async () => {
    const dev = (deviceId) => ({
      deviceId,
      identityId: "id-user-1",
      user: "user-1",
      name: "d",
      platform: "test",
      publicKey: makeIdentityKey().publicKey,
      algorithm: "ed25519",
      fingerprint: makeIdentityKey().fingerprint,
      status: "active",
      lastActive: new Date(0).toISOString(),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    await repos.devices.create(dev("device-aaaaaaa1"));
    await repos.devices.create(dev("device-bbbbbbb2"));
    await assert.rejects(() => repos.devices.create(dev("device-aaaaaaa1")), DuplicateDeviceError);
    assert.equal((await repos.devices.findByIdentity("id-user-1")).length, 2);
    assert.equal((await repos.devices.findByUser("user-1")).length, 2);
    assert.equal(await repos.devices.delete("device-aaaaaaa1"), true);
    assert.equal((await repos.devices.findByUser("user-1")).length, 1);
  });
});

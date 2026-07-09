import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toPublicIdentity,
  toPublicDevice,
  toPublicKeyBundle,
} from "../serialization/identitySerializer.js";
import { makeIdentityKey } from "./helpers.js";

describe("serialization (public DTOs — private material excluded)", () => {
  const idKey = makeIdentityKey();
  const identityRecord = {
    identityId: "id-1",
    user: "user-1",
    publicKey: idKey.publicKey,
    algorithm: "ed25519",
    fingerprint: idKey.fingerprint,
    version: 1,
    status: "active",
    metadata: { note: "x" },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    // A rogue private field must NOT leak through the DTO.
    privateKey: "SHOULD-NEVER-APPEAR",
  };

  it("toPublicIdentity whitelists public fields and formats the fingerprint", () => {
    const dto = toPublicIdentity(identityRecord);
    assert.equal(dto.identityId, "id-1");
    assert.equal(dto.publicKey, idKey.publicKey);
    assert.equal(dto.fingerprint.machine, idKey.fingerprint);
    assert.ok(dto.fingerprint.human && dto.fingerprint.numeric);
    assert.ok(!("privateKey" in dto));
    assert.ok(!JSON.stringify(dto).includes("SHOULD-NEVER-APPEAR"));
  });

  it("toPublicDevice whitelists public fields", () => {
    const dto = toPublicDevice({
      deviceId: "device-1",
      identityId: "id-1",
      user: "user-1",
      name: "Laptop",
      platform: "web",
      publicKey: idKey.publicKey,
      algorithm: "ed25519",
      fingerprint: idKey.fingerprint,
      status: "active",
      lastActive: new Date(0),
      createdAt: new Date(0),
      privateKey: "SHOULD-NEVER-APPEAR",
    });
    assert.equal(dto.deviceId, "device-1");
    assert.ok(!JSON.stringify(dto).includes("SHOULD-NEVER-APPEAR"));
  });

  it("toPublicKeyBundle exposes only key-distribution fields", () => {
    const bundle = toPublicKeyBundle(identityRecord);
    assert.deepEqual(Object.keys(bundle).sort(), ["algorithm", "fingerprint", "publicKey", "userId"]);
  });
});

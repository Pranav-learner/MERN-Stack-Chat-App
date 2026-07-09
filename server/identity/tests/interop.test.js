import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { validatePublicKeySubmission } from "../validators/identityValidators.js";
import { computeFingerprint } from "../fingerprints/fingerprint.js";
import { IdentityManager } from "../manager/identityManager.js";
import { createInMemoryRepositories } from "../repository/inMemoryRepository.js";

/**
 * Interop: the browser client uses the Web Crypto API (same spec as this module).
 * These tests generate a key exactly as the client does and prove the server
 * accepts it and computes the identical fingerprint.
 */
async function webCryptoIdentity() {
  const kp = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey("raw", kp.publicKey));
  const digest = new Uint8Array(await webcrypto.subtle.digest("SHA-256", raw));
  return {
    publicKey: Buffer.from(raw).toString("base64"),
    algorithm: "ed25519",
    fingerprint: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""),
    raw,
  };
}

describe("client ↔ server interop (Web Crypto Ed25519)", () => {
  it("server validator accepts a client-produced submission", async () => {
    const client = await webCryptoIdentity();
    const bytes = validatePublicKeySubmission(client);
    assert.equal(bytes.length, 32);
  });

  it("client and server compute the same fingerprint", async () => {
    const client = await webCryptoIdentity();
    assert.equal(computeFingerprint(client.raw), client.fingerprint);
  });

  it("a client identity registers end-to-end through the manager", async () => {
    const manager = new IdentityManager(createInMemoryRepositories());
    const client = await webCryptoIdentity();
    const device = await webCryptoIdentity();
    const { identity, device: dev } = await manager.registerIdentity({
      userId: "user-web",
      publicKey: client.publicKey,
      algorithm: client.algorithm,
      fingerprint: client.fingerprint,
      device: {
        deviceId: "dev_web_00000001",
        name: "Web",
        platform: "web (Chrome)",
        publicKey: device.publicKey,
        algorithm: device.algorithm,
        fingerprint: device.fingerprint,
      },
    });
    assert.equal(identity.fingerprint.machine, client.fingerprint);
    assert.equal(dev.deviceId, "dev_web_00000001");
  });
});

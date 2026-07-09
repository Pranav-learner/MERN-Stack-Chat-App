/**
 * Test helpers — generate real Ed25519 keys + spec-correct fingerprints without
 * any external dependency (Node's built-in crypto only). Not a test file.
 */
import crypto from "node:crypto";

/** Generate a valid Ed25519 identity public key + matching fingerprint. */
export function makeIdentityKey() {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.from(jwk.x, "base64url"); // 32 raw bytes
  return {
    publicKey: raw.toString("base64"),
    algorithm: "ed25519",
    fingerprint: crypto.createHash("sha256").update(raw).digest("hex"),
    raw,
  };
}

/** Generate a device descriptor with a valid device key. */
export function makeDeviceKey(deviceId = "device-abcdefgh", name = "Test Device", platform = "test") {
  const k = makeIdentityKey();
  return {
    deviceId,
    name,
    platform,
    publicKey: k.publicKey,
    algorithm: "ed25519",
    fingerprint: k.fingerprint,
  };
}

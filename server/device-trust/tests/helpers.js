/**
 * Test helpers — generate valid Ed25519 device submissions (Node built-ins only).
 * Not a test file.
 */
import crypto from "node:crypto";

let counter = 0;

/** Build a valid device registration submission with a real Ed25519 key. */
export function makeDeviceSubmission(overrides = {}) {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  counter += 1;
  return {
    deviceId: `dev_${crypto.randomBytes(8).toString("hex")}`,
    identityId: "identity-1",
    name: `Device ${counter}`,
    platform: "web (Chrome on Linux)",
    os: "Linux",
    appVersion: "1.0.0",
    capabilities: ["messaging"],
    publicKey: raw.toString("base64"),
    algorithm: "ed25519",
    fingerprint: crypto.createHash("sha256").update(raw).digest("hex"),
    metadata: {},
    ...overrides,
  };
}

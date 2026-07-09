/**
 * Test helpers — build a full in-memory Layer 3 stack (identity + device + trust)
 * and the integration service over it. Node built-ins only. Not a test file.
 */
import crypto from "node:crypto";
import { IdentityManager } from "../../identity/manager/identityManager.js";
import { createInMemoryRepositories } from "../../identity/repository/inMemoryRepository.js";
import { DeviceManager } from "../../device-trust/manager/deviceManager.js";
import { createInMemoryDeviceRepository } from "../../device-trust/repository/inMemoryRepository.js";
import { TrustManager } from "../../trust/manager/trustManager.js";
import { createInMemoryTrustRepositories } from "../../trust/repository/inMemoryRepository.js";
import { IdentityContextService } from "../identityContextService.js";

/** A real Ed25519 key + matching fingerprint. */
export function makeKey() {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return {
    publicKey: raw.toString("base64"),
    algorithm: "ed25519",
    fingerprint: crypto.createHash("sha256").update(raw).digest("hex"),
  };
}

/** Build a full in-memory stack + integration service. */
export function buildStack(serviceOptions = {}) {
  const identityManager = new IdentityManager(createInMemoryRepositories());
  const deviceRepos = createInMemoryDeviceRepository();
  const deviceManager = new DeviceManager({ devices: deviceRepos.devices });
  const trustManager = new TrustManager({
    ...createInMemoryTrustRepositories(),
    identityLookup: (userId) => identityManager.getIdentityByUser(userId),
    deviceLookup: async (userId) => (await deviceRepos.devices.findByUser(userId)).map((d) => d.fingerprint),
    safetyNumberOptions: { iterations: 64 },
  });
  const service = new IdentityContextService({ identityManager, deviceManager, trustManager, ...serviceOptions });
  return { identityManager, deviceManager, trustManager, deviceRepos, service };
}

/** Provision a user with an identity + one device (mirrors the client migration flow). */
export async function provision(stack, userId, options = {}) {
  const idKey = makeKey();
  const devKey = makeKey();
  const deviceId = options.deviceId ?? `dev_${crypto.randomBytes(6).toString("hex")}`;
  const { identity } = await stack.identityManager.registerIdentity({
    userId,
    publicKey: idKey.publicKey,
    algorithm: "ed25519",
    fingerprint: idKey.fingerprint,
  });
  const device = await stack.deviceManager.register({
    userId,
    identityId: identity.identityId,
    deviceId,
    publicKey: devKey.publicKey,
    algorithm: "ed25519",
    fingerprint: devKey.fingerprint,
    name: "Test Device",
    platform: "test",
  });
  return { identity, device, deviceId };
}

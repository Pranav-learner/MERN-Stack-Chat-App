/**
 * @module peer-discovery/registry/mongoIdentityDirectory
 *
 * A {@link module:peer-discovery/registry/directory directory provider} backed by the
 * Layer 3 Identity + Device Mongo collections. This is the SERVER binding that lets the
 * Discovery Registry hydrate real users' public identities and devices from the
 * authoritative identity store, so discovery works against live data without the framework
 * knowing anything about Mongoose.
 *
 * The `userId` passed to this provider is the Mongo **User** `_id` (as a string) — the same
 * `req.user._id` the JWT middleware attaches — because that is what a caller knows about a
 * peer. Identity/Device documents are keyed to a user by their `user` ObjectId ref.
 *
 * @security Returns PUBLIC material ONLY — public identity/device keys + fingerprints and
 * trust status. It never reads or returns a private key (the Identity/Device schemas have
 * no such field by design). Discoverability is derived from the device's authoritative
 * `trustStatus` (a revoked/blocked device is normalized to a non-discoverable status by
 * {@link module:peer-discovery/metadata}), NOT the legacy Sprint-1 `status` field.
 *
 * @example Server wiring
 * ```js
 * import { DiscoveryManager, createMongoDiscoveryRepository } from "../peer-discovery/index.js";
 * import { createMongoIdentityDirectory } from "../peer-discovery/registry/mongoIdentityDirectory.js";
 * const discovery = new DiscoveryManager({
 *   ...createMongoDiscoveryRepository(),
 *   directory: createMongoIdentityDirectory(),
 * });
 * ```
 */

import Identity from "../../identity/models/Identity.model.js";
import Device from "../../identity/models/Device.model.js";

/**
 * Build a directory provider over the Identity/Device collections.
 *
 * @param {{ IdentityModel?: import("mongoose").Model, DeviceModel?: import("mongoose").Model }} [models]
 *   optional model overrides (for tests)
 * @returns {{ getIdentity: (userId: string) => Promise<object|null>, getDevices: (userId: string) => Promise<object[]> }}
 */
export function createMongoIdentityDirectory(models = {}) {
  const IdentityModel = models.IdentityModel ?? Identity;
  const DeviceModel = models.DeviceModel ?? Device;

  return {
    /** Resolve a user's PUBLIC long-term identity (active only). */
    async getIdentity(userId) {
      const doc = await IdentityModel.findOne({ user: userId, status: "active" }).lean();
      if (!doc) return null;
      return {
        identityId: doc.identityId,
        publicKey: doc.publicKey, // PUBLIC identity key only
        algorithm: doc.algorithm ?? "ed25519",
        fingerprint: doc.fingerprint,
        version: doc.version ?? 1,
      };
    },

    /** Resolve a user's PUBLIC device records (discoverability derived from trustStatus). */
    async getDevices(userId) {
      const docs = await DeviceModel.find({ user: userId }).lean();
      return (docs ?? []).map((d) => ({
        deviceId: d.deviceId,
        identityId: d.identityId,
        publicKey: d.publicKey, // PUBLIC device key only
        algorithm: d.algorithm ?? "ed25519",
        fingerprint: d.fingerprint,
        name: d.name,
        platform: d.platform,
        // Hand the framework the AUTHORITATIVE trust state; it normalizes revoked/blocked/
        // inactive → non-discoverable. We deliberately omit the legacy `status` field so a
        // stale `status:"active"` can't override a revoked `trustStatus`.
        trustStatus: d.trustStatus,
      }));
    },
  };
}

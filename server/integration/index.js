/**
 * @module integration
 *
 * Layer 3 · Sprint 4 entry point. Wires the three Layer 3 subsystems (identity,
 * device-trust, trust) into MongoDB-backed managers and exposes a configured
 * {@link IdentityContextService} singleton plus the socket + token helpers used by
 * `server.js` and the session controller.
 *
 * Tests construct {@link IdentityContextService} directly with in-memory managers;
 * this module is the production wiring only.
 */

import jwt from "jsonwebtoken";
import { IdentityManager } from "../identity/manager/identityManager.js";
import { createMongoRepositories } from "../identity/repository/mongoRepository.js";
import { DeviceManager } from "../device-trust/manager/deviceManager.js";
import { createMongoDeviceRepository } from "../device-trust/repository/mongoRepository.js";
import { TrustManager } from "../trust/manager/trustManager.js";
import { createMongoTrustRepositories } from "../trust/repository/mongoRepository.js";
import { IdentityContextService } from "./identityContextService.js";
import { attachSocketIdentity } from "./socketIdentity.js";

const identityManager = new IdentityManager(createMongoRepositories());
const { devices: deviceRepo } = createMongoDeviceRepository();
const deviceManager = new DeviceManager({ devices: deviceRepo });
const trustManager = new TrustManager({
  ...createMongoTrustRepositories(),
  identityLookup: (userId) => identityManager.getIdentityByUser(userId),
  deviceLookup: async (userId) => (await deviceRepo.findByUser(userId)).map((d) => d.fingerprint),
});

/** Production identity-context service singleton. */
export const identityContextService = new IdentityContextService({
  identityManager,
  deviceManager,
  trustManager,
});

/**
 * Verify a JWT using the existing `JWT_SECRET` (does NOT change JWT issuance).
 * @param {string} token
 * @returns {object|null} the decoded payload (`{ id }`) or null if invalid
 */
export const verifyToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
};

export { attachSocketIdentity, IdentityContextService };

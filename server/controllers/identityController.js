/**
 * @module controllers/identityController
 *
 * HTTP handlers for the Identity subsystem (Layer 3, Sprint 1). Thin adapters over
 * the {@link IdentityManager}; they never touch private keys and never modify the
 * existing auth/chat controllers. All routes are mounted behind `protectedRoute`,
 * so `req.user` is the authenticated user.
 *
 * Responses are `{ success, ... }` to match the existing API convention.
 */

import { IdentityManager } from "../identity/manager/identityManager.js";
import { createMongoRepositories } from "../identity/repository/mongoRepository.js";
import { IdentityError, IdentityNotFoundError } from "../identity/errors.js";

// Single shared manager backed by MongoDB.
const manager = new IdentityManager(createMongoRepositories());

/** Map an IdentityError (or unknown error) to a JSON response. */
function handleError(res, error, where) {
  if (error instanceof IdentityError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/**
 * POST /api/identity/register
 * Establish the caller's identity and (optionally) register the calling device.
 * Body: `{ identity: { publicKey, algorithm, fingerprint, metadata? },
 *          device?: { deviceId, name?, platform?, publicKey, algorithm, fingerprint } }`
 */
export const registerIdentity = async (req, res) => {
  try {
    const userId = req.user._id;
    const { identity, device } = req.body ?? {};
    if (!identity) {
      return res.status(400).json({ success: false, message: "identity is required" });
    }
    const result = await manager.registerIdentity({
      userId,
      publicKey: identity.publicKey,
      algorithm: identity.algorithm,
      fingerprint: identity.fingerprint,
      metadata: identity.metadata,
      device,
    });
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "registerIdentity");
  }
};

/**
 * GET /api/identity/me
 * Return the caller's public identity, or `null` if not yet established.
 */
export const getMyIdentity = async (req, res) => {
  try {
    const identity = await manager.getIdentityByUser(req.user._id);
    return res.status(200).json({ success: true, identity });
  } catch (error) {
    return handleError(res, error, "getMyIdentity");
  }
};

/** GET /api/identity/fingerprint — the caller's identity fingerprint (all formats). */
export const getMyFingerprint = async (req, res) => {
  try {
    const fingerprint = await manager.getFingerprint(req.user._id);
    return res.status(200).json({ success: true, fingerprint });
  } catch (error) {
    return handleError(res, error, "getMyFingerprint");
  }
};

/**
 * POST /api/identity/devices
 * Register a new device under the caller's existing identity.
 * Body: `{ deviceId, name?, platform?, publicKey, algorithm, fingerprint }`
 */
export const registerDevice = async (req, res) => {
  try {
    const userId = req.user._id;
    const identity = await manager.getIdentityByUser(userId);
    if (!identity) {
      throw new IdentityNotFoundError("Register an identity before adding devices");
    }
    const device = await manager.registerDevice({
      userId,
      identityId: identity.identityId,
      ...req.body,
    });
    return res.status(201).json({ success: true, device });
  } catch (error) {
    return handleError(res, error, "registerDevice");
  }
};

/** GET /api/identity/devices — list the caller's devices. */
export const listDevices = async (req, res) => {
  try {
    const devices = await manager.listDevices(req.user._id);
    return res.status(200).json({ success: true, devices });
  } catch (error) {
    return handleError(res, error, "listDevices");
  }
};

/** GET /api/identity/devices/:deviceId — look up one of the caller's devices. */
export const getDevice = async (req, res) => {
  try {
    const device = await manager.getDevice(req.user._id, req.params.deviceId);
    return res.status(200).json({ success: true, device });
  } catch (error) {
    return handleError(res, error, "getDevice");
  }
};

/** PATCH /api/identity/devices/:deviceId/active — mark a device active now. */
export const touchDevice = async (req, res) => {
  try {
    const device = await manager.touchDevice(req.user._id, req.params.deviceId);
    return res.status(200).json({ success: true, device });
  } catch (error) {
    return handleError(res, error, "touchDevice");
  }
};

/**
 * GET /api/identity/users/:userId/public-key
 * Public-key bundle for another user (for future key distribution). Auth required.
 */
export const getUserPublicKey = async (req, res) => {
  try {
    const bundle = await manager.getPublicKey(req.params.userId);
    return res.status(200).json({ success: true, ...bundle });
  } catch (error) {
    return handleError(res, error, "getUserPublicKey");
  }
};

/** GET /api/identity/users/:userId/fingerprint — another user's identity fingerprint. */
export const getUserFingerprint = async (req, res) => {
  try {
    const fingerprint = await manager.getFingerprint(req.params.userId);
    return res.status(200).json({ success: true, userId: req.params.userId, fingerprint });
  } catch (error) {
    return handleError(res, error, "getUserFingerprint");
  }
};

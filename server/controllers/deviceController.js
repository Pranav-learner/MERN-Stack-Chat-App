/**
 * @module controllers/deviceController
 *
 * HTTP handlers for the Device Trust subsystem (Layer 3, Sprint 2). Thin adapters
 * over the {@link DeviceManager}. They never touch private keys and never modify
 * the existing auth/chat controllers. All routes sit behind the existing
 * `protectedRoute` JWT middleware, so `req.user` is the authenticated user.
 */

import { DeviceManager } from "../device-trust/manager/deviceManager.js";
import { createMongoDeviceRepository } from "../device-trust/repository/mongoRepository.js";
import { DeviceTrustError } from "../device-trust/errors.js";
import { IdentityManager } from "../identity/manager/identityManager.js";
import { createMongoRepositories } from "../identity/repository/mongoRepository.js";
import { IdentityError, IdentityNotFoundError } from "../identity/errors.js";

// Shared managers backed by MongoDB (identity is reused to resolve identityId).
const deviceManager = new DeviceManager({ devices: createMongoDeviceRepository().devices });
const identityManager = new IdentityManager(createMongoRepositories());

/** Map a typed error (device-trust or identity) to a JSON response. */
function handleError(res, error, where) {
  if (error instanceof DeviceTrustError || error instanceof IdentityError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/**
 * POST /api/devices/register
 * Register (or idempotently refresh) the calling device under the caller's identity.
 * Body: `{ deviceId, publicKey, algorithm, fingerprint, name?, platform?, os?, appVersion?, capabilities?, metadata? }`
 */
export const registerDevice = async (req, res) => {
  try {
    const userId = req.user._id;
    const identity = await identityManager.getIdentityByUser(userId);
    if (!identity) throw new IdentityNotFoundError("Establish an identity before registering devices");
    const device = await deviceManager.register({
      userId,
      identityId: identity.identityId,
      ...req.body,
    });
    return res.status(201).json({ success: true, device });
  } catch (error) {
    return handleError(res, error, "registerDevice");
  }
};

/** GET /api/devices — list all of the caller's devices. */
export const listDevices = async (req, res) => {
  try {
    return res.status(200).json({ success: true, devices: await deviceManager.listDevices(req.user._id) });
  } catch (error) {
    return handleError(res, error, "listDevices");
  }
};

/** GET /api/devices/trusted — list the caller's trusted devices. */
export const listTrustedDevices = async (req, res) => {
  try {
    return res.status(200).json({ success: true, devices: await deviceManager.listTrusted(req.user._id) });
  } catch (error) {
    return handleError(res, error, "listTrustedDevices");
  }
};

/** GET /api/devices/:deviceId — look up one device. */
export const getDevice = async (req, res) => {
  try {
    const device = await deviceManager.getDevice(req.user._id, req.params.deviceId);
    return res.status(200).json({ success: true, device });
  } catch (error) {
    return handleError(res, error, "getDevice");
  }
};

/** GET /api/devices/:deviceId/fingerprint — a device's fingerprint (all formats). */
export const getDeviceFingerprint = async (req, res) => {
  try {
    const fingerprint = await deviceManager.getFingerprint(req.user._id, req.params.deviceId);
    return res.status(200).json({ success: true, fingerprint });
  } catch (error) {
    return handleError(res, error, "getDeviceFingerprint");
  }
};

/** POST /api/devices/:deviceId/revoke — revoke a device. Body: `{ reason? }` */
export const revokeDevice = async (req, res) => {
  try {
    const device = await deviceManager.revoke(req.user._id, req.params.deviceId, req.body?.reason);
    return res.status(200).json({ success: true, device });
  } catch (error) {
    return handleError(res, error, "revokeDevice");
  }
};

/** POST /api/devices/:deviceId/activate — activate a device (→ trusted). */
export const activateDevice = async (req, res) => {
  try {
    const device = await deviceManager.activate(req.user._id, req.params.deviceId);
    return res.status(200).json({ success: true, device });
  } catch (error) {
    return handleError(res, error, "activateDevice");
  }
};

/** POST /api/devices/:deviceId/deactivate — deactivate a device (→ inactive). */
export const deactivateDevice = async (req, res) => {
  try {
    const device = await deviceManager.deactivate(req.user._id, req.params.deviceId);
    return res.status(200).json({ success: true, device });
  } catch (error) {
    return handleError(res, error, "deactivateDevice");
  }
};

/** PATCH /api/devices/:deviceId/rename — rename a device. Body: `{ name }` */
export const renameDevice = async (req, res) => {
  try {
    const device = await deviceManager.rename(req.user._id, req.params.deviceId, req.body?.name);
    return res.status(200).json({ success: true, device });
  } catch (error) {
    return handleError(res, error, "renameDevice");
  }
};

/** PATCH /api/devices/:deviceId/metadata — merge a metadata patch. Body: `{ metadata }` */
export const updateDeviceMetadata = async (req, res) => {
  try {
    const device = await deviceManager.updateMetadata(req.user._id, req.params.deviceId, req.body?.metadata);
    return res.status(200).json({ success: true, device });
  } catch (error) {
    return handleError(res, error, "updateDeviceMetadata");
  }
};

/** POST /api/devices/:deviceId/touch — mark a device active now. */
export const touchDevice = async (req, res) => {
  try {
    const device = await deviceManager.touch(req.user._id, req.params.deviceId);
    return res.status(200).json({ success: true, device });
  } catch (error) {
    return handleError(res, error, "touchDevice");
  }
};

/** DELETE /api/devices/:deviceId — permanently delete a device record. */
export const deleteDevice = async (req, res) => {
  try {
    const result = await deviceManager.delete(req.user._id, req.params.deviceId);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "deleteDevice");
  }
};

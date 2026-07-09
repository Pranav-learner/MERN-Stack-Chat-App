/**
 * @module routes/deviceRoute
 *
 * Device Trust API routes (Layer 3, Sprint 2), mounted at `/api/devices`. Every
 * route is protected by the EXISTING `protectedRoute` JWT middleware — device
 * trust is additive; JWT is unchanged. No private keys are accepted or returned.
 *
 * NOTE: static paths (`/trusted`) are declared before the `/:deviceId` param
 * routes so they are not shadowed.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  registerDevice,
  listDevices,
  listTrustedDevices,
  getDevice,
  getDeviceFingerprint,
  revokeDevice,
  activateDevice,
  deactivateDevice,
  renameDevice,
  updateDeviceMetadata,
  touchDevice,
  deleteDevice,
} from "../controllers/deviceController.js";

const deviceRouter = express.Router();

deviceRouter.post("/register", protectedRoute, registerDevice);
deviceRouter.get("/", protectedRoute, listDevices);
deviceRouter.get("/trusted", protectedRoute, listTrustedDevices);
deviceRouter.get("/:deviceId", protectedRoute, getDevice);
deviceRouter.get("/:deviceId/fingerprint", protectedRoute, getDeviceFingerprint);
deviceRouter.post("/:deviceId/revoke", protectedRoute, revokeDevice);
deviceRouter.post("/:deviceId/activate", protectedRoute, activateDevice);
deviceRouter.post("/:deviceId/deactivate", protectedRoute, deactivateDevice);
deviceRouter.post("/:deviceId/touch", protectedRoute, touchDevice);
deviceRouter.patch("/:deviceId/rename", protectedRoute, renameDevice);
deviceRouter.patch("/:deviceId/metadata", protectedRoute, updateDeviceMetadata);
deviceRouter.delete("/:deviceId", protectedRoute, deleteDevice);

export default deviceRouter;

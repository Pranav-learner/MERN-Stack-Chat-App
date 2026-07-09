/**
 * @module routes/identityRoute
 *
 * Identity API routes (Layer 3, Sprint 1), mounted at `/api/identity`. Every route
 * is protected by the EXISTING `protectedRoute` JWT middleware — identity is an
 * additive layer; JWT is unchanged. No private keys are ever accepted or returned.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  registerIdentity,
  getMyIdentity,
  getMyFingerprint,
  registerDevice,
  listDevices,
  getDevice,
  touchDevice,
  getUserPublicKey,
  getUserFingerprint,
} from "../controllers/identityController.js";

const identityRouter = express.Router();

// Caller's own identity & devices.
identityRouter.post("/register", protectedRoute, registerIdentity);
identityRouter.get("/me", protectedRoute, getMyIdentity);
identityRouter.get("/fingerprint", protectedRoute, getMyFingerprint);
identityRouter.post("/devices", protectedRoute, registerDevice);
identityRouter.get("/devices", protectedRoute, listDevices);
identityRouter.get("/devices/:deviceId", protectedRoute, getDevice);
identityRouter.patch("/devices/:deviceId/active", protectedRoute, touchDevice);

// Public-key distribution for other users (auth required; public data only).
identityRouter.get("/users/:userId/public-key", protectedRoute, getUserPublicKey);
identityRouter.get("/users/:userId/fingerprint", protectedRoute, getUserFingerprint);

export default identityRouter;

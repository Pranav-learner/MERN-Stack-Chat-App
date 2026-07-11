/**
 * @module routes/networkDiscoveryRoute
 *
 * Network Discovery API routes (Layer 7, Sprint 1), mounted at `/api/network-discovery`. Every route
 * is protected by the EXISTING `protectedRoute` JWT middleware; the authenticated user owns the
 * profile.
 *
 * These endpoints discover a device's network environment and produce Network Profiles + ICE-style
 * candidates. They perform NO ICE connectivity checks, NO candidate-pair selection, NO TURN relay,
 * and open NO peer socket (that is a future sprint), and never return secret key material. Static/
 * prefixed paths precede the `/profile/:profileId` route.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  generate,
  refresh,
  getProfile,
  getCurrent,
  getCandidates,
  getInterfaces,
  getPublicAddress,
  getNat,
  getDiagnostics,
} from "../controllers/networkDiscoveryController.js";

const networkDiscoveryRouter = express.Router();

// --- generation -------------------------------------------------------------
networkDiscoveryRouter.post("/generate", protectedRoute, generate);
networkDiscoveryRouter.post("/refresh", protectedRoute, refresh);

// --- per-device views -------------------------------------------------------
networkDiscoveryRouter.get("/device/:deviceId/candidates", protectedRoute, getCandidates);
networkDiscoveryRouter.get("/device/:deviceId/interfaces", protectedRoute, getInterfaces);
networkDiscoveryRouter.get("/device/:deviceId/public-address", protectedRoute, getPublicAddress);
networkDiscoveryRouter.get("/device/:deviceId/nat", protectedRoute, getNat);
networkDiscoveryRouter.get("/device/:deviceId/diagnostics", protectedRoute, getDiagnostics);
networkDiscoveryRouter.get("/device/:deviceId", protectedRoute, getCurrent);

// --- per-profile ------------------------------------------------------------
networkDiscoveryRouter.get("/profile/:profileId", protectedRoute, getProfile);

export default networkDiscoveryRouter;

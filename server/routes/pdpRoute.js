/**
 * @module routes/pdpRoute
 *
 * Peer Discovery Protocol API routes (Layer 6, Sprint 4), mounted at `/api/pdp`. Every route is
 * protected by the EXISTING `protectedRoute` JWT middleware; the authenticated user is the
 * discovery requester.
 *
 * These endpoints run the unified discovery workflow (Discovery + Presence + Capabilities) and
 * return validated CONNECTION PLANS — WHO to connect to + HOW. They establish NO connection (no NAT
 * traversal, ICE/STUN/TURN, WebRTC, sockets — that is Layer 7) and never accept or return secret
 * key material. Static/prefixed paths are declared before the `/:discoveryId` routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  startDiscovery,
  getDiscovery,
  getStatus,
  getConnectionPlan,
  getPlan,
  resolveDevices,
  resolvePreferred,
  recover,
  cancel,
  history,
} from "../controllers/pdpController.js";

const pdpRouter = express.Router();

// --- start + resolve helpers ------------------------------------------------
pdpRouter.post("/discover", protectedRoute, startDiscovery);
pdpRouter.post("/resolve-devices", protectedRoute, resolveDevices);
pdpRouter.post("/resolve-preferred", protectedRoute, resolvePreferred);

// --- history + plan-by-id ---------------------------------------------------
pdpRouter.get("/", protectedRoute, history);
pdpRouter.get("/plan/:planId", protectedRoute, getPlan);

// --- per-discovery views + actions ------------------------------------------
pdpRouter.get("/:discoveryId/status", protectedRoute, getStatus);
pdpRouter.get("/:discoveryId/plan", protectedRoute, getConnectionPlan);
pdpRouter.post("/:discoveryId/recover", protectedRoute, recover);
pdpRouter.post("/:discoveryId/cancel", protectedRoute, cancel);
pdpRouter.get("/:discoveryId", protectedRoute, getDiscovery);

export default pdpRouter;

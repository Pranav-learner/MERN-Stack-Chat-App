/**
 * @module routes/discoveryRoute
 *
 * Peer Discovery API routes (Layer 6, Sprint 1), mounted at `/api/discovery`. Every route is
 * protected by the EXISTING `protectedRoute` JWT middleware; the authenticated user is the
 * discovery requester.
 *
 * These endpoints expose the networking CONTROL PLANE only — they answer "who is this peer
 * and which devices do they have?". They carry NO transport information (no presence,
 * capability, NAT/ICE/STUN/TURN, WebRTC, or P2P) and never accept or return secret key
 * material. Static paths are declared before the `/:discoveryId` routes so they take
 * precedence.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  lookupUser,
  lookupDevice,
  lookupDevices,
  createSession,
  list,
  getDiscovery,
  getStatus,
  cancel,
  complete,
  registerDevice,
  deregisterDevice,
} from "../controllers/discoveryController.js";

const discoveryRouter = express.Router();

// --- lookups (create a discovery session + resolve) -------------------------
discoveryRouter.post("/lookup/user", protectedRoute, lookupUser);
discoveryRouter.post("/lookup/device", protectedRoute, lookupDevice);
discoveryRouter.post("/lookup/devices", protectedRoute, lookupDevices);

// --- session staging + registry self-service --------------------------------
discoveryRouter.post("/sessions", protectedRoute, createSession);
discoveryRouter.post("/register", protectedRoute, registerDevice);
discoveryRouter.post("/deregister", protectedRoute, deregisterDevice);

// --- listing ----------------------------------------------------------------
discoveryRouter.get("/", protectedRoute, list);

// --- per-session views + lifecycle actions ----------------------------------
discoveryRouter.get("/:discoveryId/status", protectedRoute, getStatus);
discoveryRouter.post("/:discoveryId/cancel", protectedRoute, cancel);
discoveryRouter.post("/:discoveryId/complete", protectedRoute, complete);
discoveryRouter.get("/:discoveryId", protectedRoute, getDiscovery);

export default discoveryRouter;

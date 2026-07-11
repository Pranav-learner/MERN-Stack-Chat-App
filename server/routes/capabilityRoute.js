/**
 * @module routes/capabilityRoute
 *
 * Capability Exchange API routes (Layer 6, Sprint 3), mounted at `/api/capabilities`. Every route
 * is protected by the EXISTING `protectedRoute` JWT middleware; the authenticated user owns the
 * capabilities it registers/updates and is the requester in a negotiation.
 *
 * These endpoints expose the negotiation CONTROL PLANE only — they determine "how can these two
 * devices communicate?" (compatibility + preferred strategy). They do NOT establish connections,
 * perform NAT traversal, or do ICE/STUN/TURN/WebRTC (later layers), and never accept or return
 * secret key material. Static/prefixed paths are declared before the `/:capabilityId` routes so
 * they take precedence.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  register,
  update,
  refresh,
  remove,
  negotiate,
  preferredTransport,
  getDeviceCapabilities,
  getHistory,
  getCapabilities,
} from "../controllers/capabilityController.js";

const capabilityRouter = express.Router();

// --- registration + negotiation --------------------------------------------
capabilityRouter.post("/register", protectedRoute, register);
capabilityRouter.post("/negotiate", protectedRoute, negotiate);
capabilityRouter.post("/preferred-transport", protectedRoute, preferredTransport);

// --- reads about devices + history -----------------------------------------
capabilityRouter.get("/device/:userId/:deviceId", protectedRoute, getDeviceCapabilities);
capabilityRouter.get("/history/:deviceId", protectedRoute, getHistory);

// --- per-capability views + lifecycle actions ------------------------------
capabilityRouter.post("/:capabilityId/refresh", protectedRoute, refresh);
capabilityRouter.patch("/:capabilityId", protectedRoute, update);
capabilityRouter.delete("/:capabilityId", protectedRoute, remove);
capabilityRouter.get("/:capabilityId", protectedRoute, getCapabilities);

export default capabilityRouter;

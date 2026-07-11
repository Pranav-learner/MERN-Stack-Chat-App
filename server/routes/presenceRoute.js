/**
 * @module routes/presenceRoute
 *
 * Presence API routes (Layer 6, Sprint 2), mounted at `/api/presence`. Every route is protected
 * by the EXISTING `protectedRoute` JWT middleware; the authenticated user owns the presence they
 * register/update/heartbeat.
 *
 * These endpoints expose the real-time availability CONTROL PLANE only — they answer "which of a
 * user's devices are currently reachable?". They carry NO transport information (no capability
 * exchange, NAT/ICE/STUN/TURN, WebRTC, or P2P) and never accept or return secret key material.
 * Static/prefixed paths are declared before the `/:presenceId` routes so they take precedence.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  register,
  update,
  heartbeat,
  goOffline,
  remove,
  lookup,
  listOnline,
  lastSeen,
  getPresence,
  getHistory,
} from "../controllers/presenceController.js";

const presenceRouter = express.Router();

// --- registration + self lifecycle ------------------------------------------
presenceRouter.post("/register", protectedRoute, register);

// --- reads about OTHER users' reachability ----------------------------------
presenceRouter.get("/lookup/:userId", protectedRoute, lookup);
presenceRouter.get("/online/:userId", protectedRoute, listOnline);
presenceRouter.get("/last-seen/:userId/:deviceId", protectedRoute, lastSeen);

// --- per-presence views + lifecycle actions ---------------------------------
presenceRouter.get("/:presenceId/history", protectedRoute, getHistory);
presenceRouter.post("/:presenceId/heartbeat", protectedRoute, heartbeat);
presenceRouter.post("/:presenceId/offline", protectedRoute, goOffline);
presenceRouter.patch("/:presenceId", protectedRoute, update);
presenceRouter.delete("/:presenceId", protectedRoute, remove);
presenceRouter.get("/:presenceId", protectedRoute, getPresence);

export default presenceRouter;

/**
 * @module routes/endpointSelectionRoute
 *
 * Endpoint Selection API routes (Layer 6, Sprint 5), mounted at `/api/endpoint-selection`. Every
 * route is protected by the EXISTING `protectedRoute` JWT middleware; the authenticated user is the
 * requester.
 *
 * These endpoints score + rank candidate devices and produce OPTIMIZED, failover-ready CONNECTION
 * PLANS (which endpoint(s) + in what order + how to retry). They establish NO connection (no NAT
 * traversal, ICE/STUN/TURN, WebRTC, sockets — that is Layer 7) and never accept or return secret
 * key material. Static/prefixed paths are declared before the `/:planId` routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  generatePlan,
  selectEndpoint,
  rankDevices,
  getPlan,
  getStatus,
  getFallbacks,
  failover,
  refreshPlan,
  updateRouting,
  recordOutcome,
  history,
} from "../controllers/endpointSelectionController.js";

const endpointSelectionRouter = express.Router();

// --- generation + ranking ---------------------------------------------------
endpointSelectionRouter.post("/plan", protectedRoute, generatePlan);
endpointSelectionRouter.post("/select", protectedRoute, selectEndpoint);
endpointSelectionRouter.post("/rank", protectedRoute, rankDevices);

// --- history ----------------------------------------------------------------
endpointSelectionRouter.get("/", protectedRoute, history);

// --- per-plan views + actions -----------------------------------------------
endpointSelectionRouter.get("/:planId/status", protectedRoute, getStatus);
endpointSelectionRouter.get("/:planId/fallbacks", protectedRoute, getFallbacks);
endpointSelectionRouter.post("/:planId/failover", protectedRoute, failover);
endpointSelectionRouter.post("/:planId/refresh", protectedRoute, refreshPlan);
endpointSelectionRouter.post("/:planId/reroute", protectedRoute, updateRouting);
endpointSelectionRouter.post("/:planId/outcome", protectedRoute, recordOutcome);
endpointSelectionRouter.get("/:planId", protectedRoute, getPlan);

export default endpointSelectionRouter;

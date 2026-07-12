/**
 * @module routes/fabricReliabilityRoute
 *
 * Production Communication Fabric reliability API routes (Layer 12, Sprint 4), mounted at
 * `/api/fabric-reliability`. Liveness + readiness are lightweight (no auth needed by orchestrators/load
 * balancers, but kept behind the standard middleware here for consistency); the operational endpoints
 * (health / diagnostics / metrics / status / freeze / operation inspection) are JWT-protected. Static
 * paths precede the `:operationId` route.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import { live, ready, health, diagnostics, metrics, inspectOperation, status, freeze } from "../controllers/fabricReliabilityController.js";

const fabricReliabilityRouter = express.Router();

// --- probes (lightweight; load balancers / orchestrators call these) --------
fabricReliabilityRouter.get("/live", live);
fabricReliabilityRouter.get("/ready", ready);

// --- operational tooling (JWT-protected) ------------------------------------
fabricReliabilityRouter.get("/health", protectedRoute, health);
fabricReliabilityRouter.get("/diagnostics", protectedRoute, diagnostics);
fabricReliabilityRouter.get("/metrics", protectedRoute, metrics);
fabricReliabilityRouter.get("/status", protectedRoute, status);
fabricReliabilityRouter.get("/freeze", protectedRoute, freeze);

// --- inspection -------------------------------------------------------------
fabricReliabilityRouter.get("/operations/:operationId", protectedRoute, inspectOperation);

export default fabricReliabilityRouter;

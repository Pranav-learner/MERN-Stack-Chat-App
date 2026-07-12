/**
 * @module routes/adaptiveRoutingRoute
 *
 * Intelligent Routing API routes (Layer 12, Sprint 2), mounted at `/api/adaptive-routing`. Every route is
 * protected by the EXISTING `protectedRoute` JWT middleware; the caller may only decide as themselves.
 *
 * `POST /evaluate` runs the full adaptive pipeline (capabilities → analysis → network → policy → scoring →
 * selection → fallback → execution plan → explanation); the other POST endpoints expose individual stages
 * (best route / capability profile / route scores / explanation / fallback plan) as dry runs. Static /
 * observability paths precede the `:requestId` route.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import { evaluateCommunication, getBestRoute, getCapabilityProfile, getRouteScores, getDecisionExplanation, getFallbackPlan, diagnostics, health } from "../controllers/adaptiveRoutingController.js";

const adaptiveRoutingRouter = express.Router();

// --- observability ----------------------------------------------------------
adaptiveRoutingRouter.get("/health", protectedRoute, health);

// --- the intelligent entry point --------------------------------------------
adaptiveRoutingRouter.post("/evaluate", protectedRoute, evaluateCommunication);

// --- pipeline stages (dry run) ----------------------------------------------
adaptiveRoutingRouter.post("/best-route", protectedRoute, getBestRoute);
adaptiveRoutingRouter.post("/capability-profile", protectedRoute, getCapabilityProfile);
adaptiveRoutingRouter.post("/route-scores", protectedRoute, getRouteScores);
adaptiveRoutingRouter.post("/explain", protectedRoute, getDecisionExplanation);
adaptiveRoutingRouter.post("/fallback-plan", protectedRoute, getFallbackPlan);

// --- diagnostics ------------------------------------------------------------
adaptiveRoutingRouter.get("/diagnostics/:requestId", protectedRoute, diagnostics);

export default adaptiveRoutingRouter;

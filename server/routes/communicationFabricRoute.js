/**
 * @module routes/communicationFabricRoute
 *
 * Distributed Communication Fabric API routes (Layer 12, Sprint 1), mounted at `/api/communication-fabric`.
 * Every route is protected by the EXISTING `protectedRoute` JWT middleware; the caller may only initiate
 * communication as themselves (enforced in the manager).
 *
 * The Fabric is the single orchestration entry point: `POST /execute` runs the full pipeline (context →
 * policies → decision → plan → orchestrate → subsystem delegation); the inspection endpoints expose each
 * pipeline stage (context / policies / strategy / plan) without executing, plus diagnostics + health.
 * Static/observability paths precede the `:requestId` route.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import { executeCommunication, planCommunication, buildContext, evaluatePolicies, getStrategy, getExecutionPlan, decisionDiagnostics, health } from "../controllers/communicationFabricController.js";

const communicationFabricRouter = express.Router();

// --- observability ----------------------------------------------------------
communicationFabricRouter.get("/health", protectedRoute, health);

// --- the single entry point -------------------------------------------------
communicationFabricRouter.post("/execute", protectedRoute, executeCommunication);
communicationFabricRouter.post("/plan", protectedRoute, planCommunication);

// --- pipeline inspection (no execution) -------------------------------------
communicationFabricRouter.post("/context", protectedRoute, buildContext);
communicationFabricRouter.post("/policies", protectedRoute, evaluatePolicies);
communicationFabricRouter.post("/strategy", protectedRoute, getStrategy);
communicationFabricRouter.post("/execution-plan", protectedRoute, getExecutionPlan);

// --- diagnostics ------------------------------------------------------------
communicationFabricRouter.get("/diagnostics/:requestId", protectedRoute, decisionDiagnostics);

export default communicationFabricRouter;

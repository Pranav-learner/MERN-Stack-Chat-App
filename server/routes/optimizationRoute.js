/**
 * @module routes/optimizationRoute
 *
 * Resource Optimization API routes (Layer 12, Sprint 3), mounted at `/api/optimization`. Every route is
 * protected by the EXISTING `protectedRoute` JWT middleware; the caller may only optimize as themselves.
 *
 * `POST /schedule` runs the full global optimization (resources → QoS → scheduling → allocation →
 * coordination → balancing → optimized plan); the other POST endpoints expose individual stages (execution
 * plan / QoS / resource allocation) as dry runs; `POST /dispatch` drains ready queued work; the GET
 * endpoints expose scheduler state, diagnostics, and status. Static/observability paths precede the
 * `:requestId` route.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import { scheduleCommunication, getExecutionPlan, getQoSProfile, getResourceAllocation, getSchedulerState, dispatch, diagnostics, status } from "../controllers/optimizationController.js";

const optimizationRouter = express.Router();

// --- observability + global state -------------------------------------------
optimizationRouter.get("/status", protectedRoute, status);
optimizationRouter.get("/scheduler-state", protectedRoute, getSchedulerState);

// --- the optimization entry point -------------------------------------------
optimizationRouter.post("/schedule", protectedRoute, scheduleCommunication);
optimizationRouter.post("/dispatch", protectedRoute, dispatch);

// --- pipeline stages (dry run) ----------------------------------------------
optimizationRouter.post("/execution-plan", protectedRoute, getExecutionPlan);
optimizationRouter.post("/qos", protectedRoute, getQoSProfile);
optimizationRouter.post("/resource-allocation", protectedRoute, getResourceAllocation);

// --- diagnostics ------------------------------------------------------------
optimizationRouter.get("/diagnostics/:requestId", protectedRoute, diagnostics);

export default optimizationRouter;

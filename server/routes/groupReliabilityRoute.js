/**
 * @module routes/groupReliabilityRoute
 *
 * Group Reliability & Production Hardening API routes (Layer 10, Sprint 3), mounted at
 * `/api/group-reliability`. Every route is protected by the EXISTING `protectedRoute` JWT middleware;
 * the authenticated user is the acting device (owner-scoped).
 *
 * This subsystem makes the Group Communication platform reliable — recovery, health monitoring, retry
 * policies, observability (metrics + Prometheus), security validation + audit, and a protocol freeze. It
 * carries NO message content or keys. Static/observability paths precede the `:operationId` /
 * `:groupId` routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  registerOperation,
  checkpoint,
  complete,
  reportInterruption,
  recover,
  resume,
  abandon,
  getRecord,
  getDiagnostics,
  listOperations,
  getGroupHealth,
  getGroupAudit,
  health,
  metrics,
  prometheus,
  alerts,
  protocol,
  securityAudit,
} from "../controllers/groupReliabilityController.js";

const groupReliabilityRouter = express.Router();

// --- observability (read-only) ----------------------------------------------
groupReliabilityRouter.get("/health", protectedRoute, health);
groupReliabilityRouter.get("/metrics", protectedRoute, metrics);
groupReliabilityRouter.get("/metrics/prometheus", protectedRoute, prometheus);
groupReliabilityRouter.get("/alerts", protectedRoute, alerts);
groupReliabilityRouter.get("/protocol", protectedRoute, protocol);
groupReliabilityRouter.get("/security-audit", protectedRoute, securityAudit);

// --- operation lifecycle ----------------------------------------------------
groupReliabilityRouter.post("/operations", protectedRoute, registerOperation);
groupReliabilityRouter.get("/operations", protectedRoute, listOperations);
groupReliabilityRouter.post("/operations/:operationId/checkpoint", protectedRoute, checkpoint);
groupReliabilityRouter.post("/operations/:operationId/complete", protectedRoute, complete);
groupReliabilityRouter.post("/operations/:operationId/interrupt", protectedRoute, reportInterruption);
groupReliabilityRouter.post("/operations/:operationId/recover", protectedRoute, recover);
groupReliabilityRouter.post("/operations/:operationId/resume", protectedRoute, resume);
groupReliabilityRouter.post("/operations/:operationId/abandon", protectedRoute, abandon);
groupReliabilityRouter.get("/operations/:operationId", protectedRoute, getRecord);
groupReliabilityRouter.get("/operations/:operationId/diagnostics", protectedRoute, getDiagnostics);

// --- per-group reads --------------------------------------------------------
groupReliabilityRouter.get("/groups/:groupId/health", protectedRoute, getGroupHealth);
groupReliabilityRouter.get("/groups/:groupId/audit", protectedRoute, getGroupAudit);

export default groupReliabilityRouter;

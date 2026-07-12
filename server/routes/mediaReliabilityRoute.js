/**
 * @module routes/mediaReliabilityRoute
 *
 * Media Reliability & Production Hardening API routes (Layer 11, Sprint 3), mounted at
 * `/api/media-reliability`. Every route is protected by the EXISTING `protectedRoute` JWT middleware; the
 * authenticated user is the acting device (owner-scoped).
 *
 * This subsystem makes the Secure Media Platform reliable — recovery, health monitoring, retry policies,
 * observability (metrics + Prometheus), a hot-metadata cache, security validation + audit, and a protocol
 * freeze. It carries NO media content or keys. Static/observability paths precede the `:id` routes.
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
  getMediaHealth,
  getMediaAudit,
  health,
  metrics,
  prometheus,
  alerts,
  protocol,
  securityAudit,
} from "../controllers/mediaReliabilityController.js";

const mediaReliabilityRouter = express.Router();

// --- observability (read-only) ----------------------------------------------
mediaReliabilityRouter.get("/health", protectedRoute, health);
mediaReliabilityRouter.get("/metrics", protectedRoute, metrics);
mediaReliabilityRouter.get("/metrics/prometheus", protectedRoute, prometheus);
mediaReliabilityRouter.get("/alerts", protectedRoute, alerts);
mediaReliabilityRouter.get("/protocol", protectedRoute, protocol);
mediaReliabilityRouter.get("/security-audit", protectedRoute, securityAudit);

// --- operation lifecycle ----------------------------------------------------
mediaReliabilityRouter.post("/operations", protectedRoute, registerOperation);
mediaReliabilityRouter.get("/operations", protectedRoute, listOperations);
mediaReliabilityRouter.post("/operations/:operationId/checkpoint", protectedRoute, checkpoint);
mediaReliabilityRouter.post("/operations/:operationId/complete", protectedRoute, complete);
mediaReliabilityRouter.post("/operations/:operationId/interrupt", protectedRoute, reportInterruption);
mediaReliabilityRouter.post("/operations/:operationId/recover", protectedRoute, recover);
mediaReliabilityRouter.post("/operations/:operationId/resume", protectedRoute, resume);
mediaReliabilityRouter.post("/operations/:operationId/abandon", protectedRoute, abandon);
mediaReliabilityRouter.get("/operations/:operationId", protectedRoute, getRecord);
mediaReliabilityRouter.get("/operations/:operationId/diagnostics", protectedRoute, getDiagnostics);

// --- per-media reads --------------------------------------------------------
mediaReliabilityRouter.get("/media/:mediaId/health", protectedRoute, getMediaHealth);
mediaReliabilityRouter.get("/media/:mediaId/audit", protectedRoute, getMediaAudit);

export default mediaReliabilityRouter;

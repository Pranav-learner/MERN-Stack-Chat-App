/**
 * @module routes/syncReliabilityRoute
 *
 * Synchronization Reliability API routes (Layer 9, Sprint 3), mounted at `/api/sync-reliability`. Every
 * route is protected by the EXISTING `protectedRoute` JWT middleware; the authenticated user (device)
 * owns its synchronization.
 *
 * These endpoints make synchronization reliable — register/checkpoint/interrupt/recover/resume/complete/
 * abandon + read-only health/metrics/alerts/diagnostics + the frozen protocol manifest + security
 * audit. They carry NO message content or keys. Static / observability paths precede the
 * `/syncs/:syncId` routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  register,
  checkpoint,
  interrupt,
  recover,
  resume,
  complete,
  abandon,
  getSync,
  getHealth,
  getDiagnostics,
  listSyncs,
  health,
  metrics,
  alerts,
  protocol,
  securityAudit,
} from "../controllers/syncReliabilityController.js";

const syncReliabilityRouter = express.Router();

// --- observability (read-only) ----------------------------------------------
syncReliabilityRouter.get("/health", protectedRoute, health);
syncReliabilityRouter.get("/metrics", protectedRoute, metrics);
syncReliabilityRouter.get("/alerts", protectedRoute, alerts);
syncReliabilityRouter.get("/protocol", protectedRoute, protocol);
syncReliabilityRouter.get("/security-audit", protectedRoute, securityAudit);

// --- syncs collection -------------------------------------------------------
syncReliabilityRouter.post("/syncs", protectedRoute, register);
syncReliabilityRouter.get("/syncs", protectedRoute, listSyncs);

// --- per-sync actions -------------------------------------------------------
syncReliabilityRouter.post("/syncs/:syncId/checkpoint", protectedRoute, checkpoint);
syncReliabilityRouter.post("/syncs/:syncId/interrupt", protectedRoute, interrupt);
syncReliabilityRouter.post("/syncs/:syncId/recover", protectedRoute, recover);
syncReliabilityRouter.post("/syncs/:syncId/resume", protectedRoute, resume);
syncReliabilityRouter.post("/syncs/:syncId/complete", protectedRoute, complete);
syncReliabilityRouter.post("/syncs/:syncId/abandon", protectedRoute, abandon);

// --- per-sync reads ---------------------------------------------------------
syncReliabilityRouter.get("/syncs/:syncId/health", protectedRoute, getHealth);
syncReliabilityRouter.get("/syncs/:syncId/diagnostics", protectedRoute, getDiagnostics);
syncReliabilityRouter.get("/syncs/:syncId", protectedRoute, getSync);

export default syncReliabilityRouter;

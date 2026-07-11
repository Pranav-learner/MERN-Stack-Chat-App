/**
 * @module routes/transportReliabilityRoute
 *
 * Data Plane Reliability API routes (Layer 8, Sprint 3), mounted at `/api/transport-reliability`.
 * Every route is protected by the EXISTING `protectedRoute` JWT middleware; the authenticated user
 * (device) is a transfer participant.
 *
 * These endpoints make transfers reliable — register/checkpoint/interrupt/recover/resume/migrate/
 * complete/abandon + read-only health/metrics/alerts/diagnostics + the frozen protocol manifest +
 * security audit. They carry NO payload bytes or keys. Static/collection paths precede the
 * `/transfers/:transferId` routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  register,
  checkpoint,
  interrupt,
  recover,
  resume,
  migrate,
  complete,
  abandon,
  getTransfer,
  getHealth,
  getDiagnostics,
  listTransfers,
  health,
  metrics,
  alerts,
  protocol,
  securityAudit,
} from "../controllers/transportReliabilityController.js";

const transportReliabilityRouter = express.Router();

// --- observability (read-only) ----------------------------------------------
transportReliabilityRouter.get("/health", protectedRoute, health);
transportReliabilityRouter.get("/metrics", protectedRoute, metrics);
transportReliabilityRouter.get("/alerts", protectedRoute, alerts);
transportReliabilityRouter.get("/protocol", protectedRoute, protocol);
transportReliabilityRouter.get("/security-audit", protectedRoute, securityAudit);

// --- transfers collection ---------------------------------------------------
transportReliabilityRouter.post("/transfers", protectedRoute, register);
transportReliabilityRouter.get("/transfers", protectedRoute, listTransfers);

// --- per-transfer actions ---------------------------------------------------
transportReliabilityRouter.post("/transfers/:transferId/checkpoint", protectedRoute, checkpoint);
transportReliabilityRouter.post("/transfers/:transferId/interrupt", protectedRoute, interrupt);
transportReliabilityRouter.post("/transfers/:transferId/recover", protectedRoute, recover);
transportReliabilityRouter.post("/transfers/:transferId/resume", protectedRoute, resume);
transportReliabilityRouter.post("/transfers/:transferId/migrate", protectedRoute, migrate);
transportReliabilityRouter.post("/transfers/:transferId/complete", protectedRoute, complete);
transportReliabilityRouter.post("/transfers/:transferId/abandon", protectedRoute, abandon);

// --- per-transfer reads -----------------------------------------------------
transportReliabilityRouter.get("/transfers/:transferId/health", protectedRoute, getHealth);
transportReliabilityRouter.get("/transfers/:transferId/diagnostics", protectedRoute, getDiagnostics);
transportReliabilityRouter.get("/transfers/:transferId", protectedRoute, getTransfer);

export default transportReliabilityRouter;

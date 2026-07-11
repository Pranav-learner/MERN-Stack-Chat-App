/**
 * @module routes/synchronizationRoute
 *
 * Offline Synchronization API routes (Layer 9, Sprint 1), mounted at `/api/synchronization`. Every
 * route is protected by the EXISTING `protectedRoute` JWT middleware; the authenticated user (device)
 * owns its replica + sessions.
 *
 * These endpoints synchronize ENCRYPTED application state by computing deltas + deterministic plans +
 * driving resumable sessions. They carry VERSION METADATA + entity IDs ONLY (no plaintext/keys) and do
 * NOT do conflict resolution / merge / group sync (Sprint 2). Static / collection paths precede the
 * `/sessions/:sessionId` routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  registerReplica,
  getReplica,
  computeMissingState,
  startSync,
  getNextOperations,
  recordProgress,
  pauseSync,
  resumeSync,
  cancelSync,
  getSession,
  getStatus,
  getDiagnostics,
  listSessions,
  health,
} from "../controllers/synchronizationController.js";

const synchronizationRouter = express.Router();

// --- observability / replicas / delta ---------------------------------------
synchronizationRouter.get("/health", protectedRoute, health);
synchronizationRouter.post("/replicas", protectedRoute, registerReplica);
synchronizationRouter.get("/replicas/me", protectedRoute, getReplica);
synchronizationRouter.post("/delta", protectedRoute, computeMissingState);

// --- sessions collection ----------------------------------------------------
synchronizationRouter.post("/sessions", protectedRoute, startSync);
synchronizationRouter.get("/sessions", protectedRoute, listSessions);

// --- per-session actions ----------------------------------------------------
synchronizationRouter.get("/sessions/:sessionId/operations", protectedRoute, getNextOperations);
synchronizationRouter.post("/sessions/:sessionId/progress", protectedRoute, recordProgress);
synchronizationRouter.post("/sessions/:sessionId/pause", protectedRoute, pauseSync);
synchronizationRouter.post("/sessions/:sessionId/resume", protectedRoute, resumeSync);
synchronizationRouter.post("/sessions/:sessionId/cancel", protectedRoute, cancelSync);

// --- per-session reads ------------------------------------------------------
synchronizationRouter.get("/sessions/:sessionId/status", protectedRoute, getStatus);
synchronizationRouter.get("/sessions/:sessionId/diagnostics", protectedRoute, getDiagnostics);
synchronizationRouter.get("/sessions/:sessionId", protectedRoute, getSession);

export default synchronizationRouter;

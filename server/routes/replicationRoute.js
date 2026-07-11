/**
 * @module routes/replicationRoute
 *
 * State Replication & Conflict Resolution API routes (Layer 9, Sprint 2), mounted at
 * `/api/replication`. Every route is protected by the EXISTING `protectedRoute` JWT middleware; the
 * authenticated user (device) owns its replica.
 *
 * These endpoints keep encrypted replicas eventually consistent — register/compare/synchronize/merge/
 * resolve/delta/resume + version & conflict history + diagnostics. They carry VERSION METADATA + entity
 * IDs + non-secret merge metadata ONLY (no plaintext/keys) and do NOT implement consensus / CRDTs /
 * monitoring (Sprint 3 / later). Static / collection paths precede the `/replicas/:replicaId` routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  registerReplica,
  getReplicaStatus,
  compareReplicas,
  synchronizeReplicas,
  mergeReplica,
  resolveConflict,
  replicateDelta,
  resumeSynchronization,
  getVersionHistory,
  getConflictHistory,
  getDiagnostics,
  health,
} from "../controllers/replicationController.js";

const replicationRouter = express.Router();

// --- observability / replica ------------------------------------------------
replicationRouter.get("/health", protectedRoute, health);
replicationRouter.post("/replicas", protectedRoute, registerReplica);
replicationRouter.get("/replicas/me", protectedRoute, getReplicaStatus);

// --- comparison + synchronization -------------------------------------------
replicationRouter.post("/compare", protectedRoute, compareReplicas);
replicationRouter.post("/synchronize", protectedRoute, synchronizeReplicas);
replicationRouter.post("/merge", protectedRoute, mergeReplica);
replicationRouter.post("/resolve", protectedRoute, resolveConflict);
replicationRouter.post("/delta", protectedRoute, replicateDelta);
replicationRouter.post("/resume", protectedRoute, resumeSynchronization);

// --- per-replica reads ------------------------------------------------------
replicationRouter.get("/replicas/:replicaId/version-history", protectedRoute, getVersionHistory);
replicationRouter.get("/replicas/:replicaId/conflict-history", protectedRoute, getConflictHistory);
replicationRouter.get("/replicas/:replicaId/diagnostics", protectedRoute, getDiagnostics);

export default replicationRouter;

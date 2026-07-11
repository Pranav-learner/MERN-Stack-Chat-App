/**
 * @module routes/transportEngineRoute
 *
 * Large Payload Transport Engine API routes (Layer 8, Sprint 2), mounted at `/api/transport-engine`.
 * Every route is protected by the EXISTING `protectedRoute` JWT middleware; the authenticated user
 * (device) is the acting sender/receiver.
 *
 * The server is a BLIND chunk relay: open a transfer, relay opaque ciphertext chunks, pull an inbox,
 * ACK, control (pause/resume/cancel), and read progress/chunk-status/diagnostics. It carries opaque
 * ciphertext ONLY (no plaintext, no keys) and does NOT do live media (Layer 11). Static / collection
 * paths precede the `/:transferId` routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  openTransfer,
  relayChunk,
  pullChunks,
  ackChunks,
  pauseTransfer,
  resumeTransfer,
  cancelTransfer,
  getTransfer,
  getProgress,
  getChunkStatus,
  listActiveTransfers,
  getDiagnostics,
  relayStatus,
} from "../controllers/transportEngineController.js";

const transportEngineRouter = express.Router();

// --- collection / observability ---------------------------------------------
transportEngineRouter.get("/status", protectedRoute, relayStatus);
transportEngineRouter.get("/diagnostics/:conversationId", protectedRoute, getDiagnostics);
transportEngineRouter.post("/transfers", protectedRoute, openTransfer);
transportEngineRouter.get("/transfers", protectedRoute, listActiveTransfers);

// --- per-transfer actions ---------------------------------------------------
transportEngineRouter.post("/transfers/:transferId/chunks", protectedRoute, relayChunk);
transportEngineRouter.get("/transfers/:transferId/inbox", protectedRoute, pullChunks);
transportEngineRouter.post("/transfers/:transferId/ack", protectedRoute, ackChunks);
transportEngineRouter.post("/transfers/:transferId/pause", protectedRoute, pauseTransfer);
transportEngineRouter.post("/transfers/:transferId/resume", protectedRoute, resumeTransfer);
transportEngineRouter.post("/transfers/:transferId/cancel", protectedRoute, cancelTransfer);

// --- per-transfer reads -----------------------------------------------------
transportEngineRouter.get("/transfers/:transferId/progress", protectedRoute, getProgress);
transportEngineRouter.get("/transfers/:transferId/chunks", protectedRoute, getChunkStatus);
transportEngineRouter.get("/transfers/:transferId", protectedRoute, getTransfer);

export default transportEngineRouter;

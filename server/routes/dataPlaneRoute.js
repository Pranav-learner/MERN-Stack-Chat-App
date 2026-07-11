/**
 * @module routes/dataPlaneRoute
 *
 * Reliable P2P Messaging (data plane) API routes (Layer 8, Sprint 1), mounted at `/api/data-plane`.
 * Every route is protected by the EXISTING `protectedRoute` JWT middleware; the authenticated user
 * (device) is the acting sender/receiver.
 *
 * The server is a BLIND store-and-forward relay: relay an encrypted message, pull an inbox, ACK,
 * and read delivery status/history/diagnostics. It carries OPAQUE ciphertext only (no plaintext, no
 * keys) and does NOT do file transfer/media (Layer 8, Sprint 2). Static/observability paths precede
 * the `/:messageId` action routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  relay,
  inbox,
  acknowledge,
  getStatus,
  getPending,
  getHistory,
  getDiagnostics,
  relayStatus,
} from "../controllers/dataPlaneController.js";

const dataPlaneRouter = express.Router();

// --- send / receive ---------------------------------------------------------
dataPlaneRouter.post("/relay", protectedRoute, relay);
dataPlaneRouter.get("/inbox/:conversationId", protectedRoute, inbox);

// --- observability / reads --------------------------------------------------
dataPlaneRouter.get("/status", protectedRoute, relayStatus);
dataPlaneRouter.get("/pending/:conversationId", protectedRoute, getPending);
dataPlaneRouter.get("/history/:conversationId", protectedRoute, getHistory);
dataPlaneRouter.get("/diagnostics/:conversationId", protectedRoute, getDiagnostics);

// --- per-message ------------------------------------------------------------
dataPlaneRouter.get("/:messageId/status", protectedRoute, getStatus);
dataPlaneRouter.post("/:messageId/ack", protectedRoute, acknowledge);

export default dataPlaneRouter;

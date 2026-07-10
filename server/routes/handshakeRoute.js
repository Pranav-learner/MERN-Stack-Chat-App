/**
 * @module routes/handshakeRoute
 *
 * Secure Handshake API routes (Layer 4, Sprint 1), mounted at `/api/handshake`.
 * Every route is protected by the EXISTING `protectedRoute` JWT middleware — SHS is
 * additive; JWT is unchanged. These endpoints drive the handshake PROTOCOL lifecycle
 * only; they establish NO shared secrets and return NO key material.
 *
 * Static paths are declared before `/:id/*` param routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  startHandshake,
  acceptHandshake,
  completeHandshake,
  rejectHandshake,
  cancelHandshake,
  resumeHandshake,
  restartHandshake,
  getHandshake,
  listSessions,
  getProtocolInfo,
} from "../controllers/handshakeController.js";

const handshakeRouter = express.Router();

// Collection + protocol metadata.
handshakeRouter.get("/protocol/info", protectedRoute, getProtocolInfo);
handshakeRouter.get("/", protectedRoute, listSessions);
handshakeRouter.post("/start", protectedRoute, startHandshake);

// Per-handshake lifecycle actions.
handshakeRouter.post("/:id/accept", protectedRoute, acceptHandshake);
handshakeRouter.post("/:id/complete", protectedRoute, completeHandshake);
handshakeRouter.post("/:id/reject", protectedRoute, rejectHandshake);
handshakeRouter.post("/:id/cancel", protectedRoute, cancelHandshake);
handshakeRouter.post("/:id/resume", protectedRoute, resumeHandshake);
handshakeRouter.post("/:id/restart", protectedRoute, restartHandshake);
handshakeRouter.get("/:id", protectedRoute, getHandshake);

export default handshakeRouter;

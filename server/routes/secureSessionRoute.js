/**
 * @module routes/secureSessionRoute
 *
 * Secure Session API routes (Layer 4, Sprint 3), mounted at `/api/secure-session`
 * (distinct from the Layer 3 `/api/session` identity-context routes). Every route is
 * protected by the EXISTING `protectedRoute` JWT middleware — sessions are additive.
 *
 * The server runs in descriptor mode: these endpoints track session lifecycle
 * METADATA. They NEVER accept or return session keys, MAC keys, private keys, or
 * shared secrets. Static paths precede `/:sessionId/*` param routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  registerSession,
  listSessions,
  getActiveByHandshake,
  getSession,
  getStatus,
  resumeSession,
  trackActivity,
  closeSession,
} from "../controllers/secureSessionController.js";

const secureSessionRouter = express.Router();

// Collection + creation.
secureSessionRouter.get("/", protectedRoute, listSessions);
secureSessionRouter.post("/register", protectedRoute, registerSession);
secureSessionRouter.get("/handshake/:handshakeId", protectedRoute, getActiveByHandshake);

// Per-session lifecycle.
secureSessionRouter.get("/:sessionId/status", protectedRoute, getStatus);
secureSessionRouter.post("/:sessionId/resume", protectedRoute, resumeSession);
secureSessionRouter.post("/:sessionId/activity", protectedRoute, trackActivity);
secureSessionRouter.post("/:sessionId/close", protectedRoute, closeSession);
secureSessionRouter.get("/:sessionId", protectedRoute, getSession);

export default secureSessionRouter;

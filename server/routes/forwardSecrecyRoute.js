/**
 * @module routes/forwardSecrecyRoute
 *
 * Forward Secrecy API routes (Layer 5, Sprint 2), mounted at `/api/forward-secrecy`.
 * Every route is protected by the EXISTING `protectedRoute` JWT middleware and enforces
 * session participation.
 *
 * The server runs in descriptor mode: these endpoints track forward-secrecy generation
 * METADATA a device produced. They NEVER accept or return chain secrets, session keys,
 * MAC keys, or shared secrets. Static paths precede the `/:sessionId` param route.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  startForwardSecrecy,
  reportEvolution,
  getForwardSecrecyState,
  getForwardSecrecyStatus,
  getGenerationHistory,
  getForwardSecrecyAudit,
} from "../controllers/forwardSecrecyController.js";

const forwardSecrecyRouter = express.Router();

// Device metadata reports (no key material).
forwardSecrecyRouter.post("/:sessionId/start", protectedRoute, startForwardSecrecy);
forwardSecrecyRouter.post("/:sessionId/evolve", protectedRoute, reportEvolution);

// Read-only awareness.
forwardSecrecyRouter.get("/:sessionId/status", protectedRoute, getForwardSecrecyStatus);
forwardSecrecyRouter.get("/:sessionId/history", protectedRoute, getGenerationHistory);
forwardSecrecyRouter.get("/:sessionId/audit", protectedRoute, getForwardSecrecyAudit);
forwardSecrecyRouter.get("/:sessionId", protectedRoute, getForwardSecrecyState);

export default forwardSecrecyRouter;

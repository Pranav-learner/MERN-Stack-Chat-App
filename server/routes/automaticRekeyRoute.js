/**
 * @module routes/automaticRekeyRoute
 *
 * Automatic Rekeying API routes (Layer 5, Sprint 3), mounted at `/api/auto-rekey`. Every
 * route is protected by the EXISTING `protectedRoute` JWT middleware and enforces session
 * participation.
 *
 * These endpoints configure rekey POLICIES and expose rekey/execution history METADATA.
 * They NEVER accept or return keys, chain secrets, or shared secrets — the key evolution is
 * device-local (Sprint 2). Static paths precede the `/:sessionId` param route.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  configure,
  getState,
  getStatus,
  getRekeyHistory,
  getExecutions,
  getAudit,
} from "../controllers/automaticRekeyController.js";

const automaticRekeyRouter = express.Router();

automaticRekeyRouter.post("/:sessionId/configure", protectedRoute, configure);
automaticRekeyRouter.get("/:sessionId/status", protectedRoute, getStatus);
automaticRekeyRouter.get("/:sessionId/history", protectedRoute, getRekeyHistory);
automaticRekeyRouter.get("/:sessionId/executions", protectedRoute, getExecutions);
automaticRekeyRouter.get("/:sessionId/audit", protectedRoute, getAudit);
automaticRekeyRouter.get("/:sessionId", protectedRoute, getState);

export default automaticRekeyRouter;

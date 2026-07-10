/**
 * @module routes/messageKeyRoute
 *
 * Per-Message Key API routes (Layer 5, Sprint 5), mounted at `/api/message-keys`. Every route
 * is protected by the EXISTING `protectedRoute` JWT middleware and enforces session
 * participation.
 *
 * These endpoints record + expose per-message METADATA (numbers, key ids, fingerprints,
 * delivery status). They NEVER accept or return a message key, chain key, or shared secret —
 * per-message keys are ephemeral + device-local. Static paths precede the `/:sessionId` route.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  reportMessage,
  getState,
  getStatus,
  getMessages,
} from "../controllers/messageKeyController.js";

const messageKeyRouter = express.Router();

messageKeyRouter.post("/:sessionId/report", protectedRoute, reportMessage);
messageKeyRouter.get("/:sessionId/status", protectedRoute, getStatus);
messageKeyRouter.get("/:sessionId/messages", protectedRoute, getMessages);
messageKeyRouter.get("/:sessionId", protectedRoute, getState);

export default messageKeyRouter;

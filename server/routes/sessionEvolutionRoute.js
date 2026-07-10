/**
 * @module routes/sessionEvolutionRoute
 *
 * Session Evolution API routes (Layer 5, Sprint 1), mounted at `/api/session-evolution`.
 * Every route is protected by the EXISTING `protectedRoute` JWT middleware and is
 * READ-ONLY — evolution is an awareness layer here, not a key-rotation surface.
 *
 * These endpoints expose that a Secure Session has a generation, an evolution lifecycle
 * state, policies, and metadata. They NEVER accept or return keys, MAC keys, private
 * keys, shared secrets, or ratchet state. Static paths precede `/:sessionId` param routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  getEvolutionState,
  getEvolutionStatus,
  getEvolutionMetadata,
  getGenerationHistory,
} from "../controllers/sessionEvolutionController.js";

const sessionEvolutionRouter = express.Router();

sessionEvolutionRouter.get("/:sessionId/status", protectedRoute, getEvolutionStatus);
sessionEvolutionRouter.get("/:sessionId/metadata", protectedRoute, getEvolutionMetadata);
sessionEvolutionRouter.get("/:sessionId/history", protectedRoute, getGenerationHistory);
sessionEvolutionRouter.get("/:sessionId", protectedRoute, getEvolutionState);

export default sessionEvolutionRouter;

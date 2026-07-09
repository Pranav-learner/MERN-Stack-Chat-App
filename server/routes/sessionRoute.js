/**
 * @module routes/sessionRoute
 *
 * Layer 3 · Sprint 4 — session/identity-context routes, mounted at `/api/session`.
 * Behind the EXISTING `protectedRoute` JWT middleware; additive; JWT unchanged.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import { getContext, validateSession, getDirectory } from "../controllers/sessionController.js";

const sessionRouter = express.Router();

sessionRouter.get("/context", protectedRoute, getContext);
sessionRouter.get("/validate", protectedRoute, validateSession);
sessionRouter.get("/directory", protectedRoute, getDirectory);

export default sessionRouter;

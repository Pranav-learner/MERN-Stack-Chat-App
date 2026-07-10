/**
 * @module routes/sessionMessagingRoute
 *
 * Layer 4 · Sprint 5 — Secure Session Integration status/stats routes, mounted at
 * `/api/messaging-session`. Additive; every route is protected by the EXISTING
 * `protectedRoute` JWT middleware. Exposes the caller's session context, transport
 * readiness, and aggregate integration metrics — never keys or message content.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import { getSessionContext, getStatus, getStats } from "../controllers/sessionMessagingController.js";

const sessionMessagingRouter = express.Router();

sessionMessagingRouter.get("/status", protectedRoute, getStatus);
sessionMessagingRouter.get("/stats", protectedRoute, getStats);
sessionMessagingRouter.get("/context/:peerId", protectedRoute, getSessionContext);

export default sessionMessagingRouter;

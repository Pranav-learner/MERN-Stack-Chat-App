/**
 * @module routes/secureTransportRoute
 *
 * Layer 4 · Sprint 6 — Secure Transport status/metrics routes, mounted at
 * `/api/secure-transport`. Additive; protected by the EXISTING `protectedRoute` JWT.
 * Exposes the relay posture + aggregate metrics — never keys, plaintext, or content.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import { getStatus, getMetrics } from "../controllers/secureTransportController.js";

const secureTransportRouter = express.Router();

secureTransportRouter.get("/status", protectedRoute, getStatus);
secureTransportRouter.get("/metrics", protectedRoute, getMetrics);

export default secureTransportRouter;

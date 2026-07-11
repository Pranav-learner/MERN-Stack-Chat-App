/**
 * @module routes/networkingHardeningRoute
 *
 * Networking Hardening API routes (Layer 6, Sprint 6), mounted at `/api/networking-hardening`. Every
 * route is protected by the EXISTING `protectedRoute` JWT middleware. These endpoints are READ-ONLY
 * production observability + security posture for the whole Layer-6 control plane — health, metrics,
 * alerts, the frozen protocol manifest, and the API security audit. They NEVER return key material.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  getHealth,
  getMetrics,
  getAlerts,
  getProtocol,
  getSecurityAudit,
} from "../controllers/networkingHardeningController.js";

const networkingHardeningRouter = express.Router();

networkingHardeningRouter.get("/health", protectedRoute, getHealth);
networkingHardeningRouter.get("/metrics", protectedRoute, getMetrics);
networkingHardeningRouter.get("/alerts", protectedRoute, getAlerts);
networkingHardeningRouter.get("/protocol", protectedRoute, getProtocol);
networkingHardeningRouter.get("/security-audit", protectedRoute, getSecurityAudit);

export default networkingHardeningRouter;

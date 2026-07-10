/**
 * @module routes/cryptoHardeningRoute
 *
 * Cryptographic Hardening API routes (Layer 5, Sprint 6), mounted at `/api/crypto-hardening`.
 * Every route is protected by the EXISTING `protectedRoute` JWT middleware. These endpoints are
 * READ-ONLY observability + security posture — metrics, alerts, the frozen protocol manifest,
 * and per-session replay status. They NEVER return key material.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  getMetrics,
  getAlerts,
  getProtocol,
  getReplayStatus,
} from "../controllers/cryptoHardeningController.js";

const cryptoHardeningRouter = express.Router();

cryptoHardeningRouter.get("/metrics", protectedRoute, getMetrics);
cryptoHardeningRouter.get("/alerts", protectedRoute, getAlerts);
cryptoHardeningRouter.get("/protocol", protectedRoute, getProtocol);
cryptoHardeningRouter.get("/replay/:sessionId", protectedRoute, getReplayStatus);

export default cryptoHardeningRouter;

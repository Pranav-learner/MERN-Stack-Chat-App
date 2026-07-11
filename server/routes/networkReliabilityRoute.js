/**
 * @module routes/networkReliabilityRoute
 *
 * Network Reliability API routes (Layer 7, Sprint 3), mounted at `/api/network-reliability`. Every
 * route is protected by the EXISTING `protectedRoute` JWT middleware; the authenticated user (device)
 * owns the connection.
 *
 * These endpoints make active connections reliable — register/heartbeat/recover/reconnect/close +
 * read-only health/metrics/alerts/diagnostics + the frozen protocol manifest. They carry NO
 * application data (no P2P messaging/media/file transfer — Layer 8) and never return key material.
 * Static/observability paths precede the `/:connectionId` action routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  register,
  heartbeat,
  recover,
  reconnect,
  networkEvent,
  close,
  getConnection,
  getHealth,
  getDiagnostics,
  listConnections,
  health,
  metrics,
  alerts,
  protocol,
} from "../controllers/networkReliabilityController.js";

const networkReliabilityRouter = express.Router();

// --- registration -----------------------------------------------------------
networkReliabilityRouter.post("/register", protectedRoute, register);

// --- observability (read-only) ----------------------------------------------
networkReliabilityRouter.get("/health", protectedRoute, health);
networkReliabilityRouter.get("/metrics", protectedRoute, metrics);
networkReliabilityRouter.get("/alerts", protectedRoute, alerts);
networkReliabilityRouter.get("/protocol", protectedRoute, protocol);
networkReliabilityRouter.get("/connections", protectedRoute, listConnections);

// --- per-connection reads ---------------------------------------------------
networkReliabilityRouter.get("/connection/:connectionId/health", protectedRoute, getHealth);
networkReliabilityRouter.get("/connection/:connectionId/diagnostics", protectedRoute, getDiagnostics);
networkReliabilityRouter.get("/connection/:connectionId", protectedRoute, getConnection);

// --- per-connection actions -------------------------------------------------
networkReliabilityRouter.post("/:connectionId/heartbeat", protectedRoute, heartbeat);
networkReliabilityRouter.post("/:connectionId/recover", protectedRoute, recover);
networkReliabilityRouter.post("/:connectionId/reconnect", protectedRoute, reconnect);
networkReliabilityRouter.post("/:connectionId/network-event", protectedRoute, networkEvent);
networkReliabilityRouter.post("/:connectionId/close", protectedRoute, close);

export default networkReliabilityRouter;

/**
 * @module controllers/networkReliabilityController
 *
 * HTTP handlers for the **Network Reliability** subsystem (Layer 7, Sprint 3), mounted at
 * `/api/network-reliability`. Devices register their ACTIVE CONNECTIONS (established by Sprint 2),
 * heartbeat them, report network events, and request recovery; the server tracks state + health,
 * drives session-preserving recovery, and exposes READ-ONLY observability (health, metrics,
 * Prometheus, alerts, the frozen protocol manifest).
 *
 * This subsystem makes connections reliable — it carries NO application data (no P2P messaging, data
 * channels, media, or file transfer; that is Layer 8). Every route is JWT-protected; the
 * authenticated `req.user._id` is the connection owner (`actingDevice`).
 *
 * @security Returns CONTROL-PLANE metadata only — never key material. The `sessionId` on a connection
 * is an id (session continuity), not a key.
 *
 * @note The recovery HOOKS here are server-side defaults: the reliability layer tracks + orchestrates
 * recovery state, while the DEVICE performs the actual transport reconnect (Sprint 2's Connection
 * Manager) and confirms it via a heartbeat. A deployment wiring Sprint 2 injects concrete hooks.
 */

import { NetworkReliabilityManager } from "../network-reliability/manager/networkReliabilityManager.js";
import { createReliabilityApi } from "../network-reliability/api/reliabilityApi.js";
import { createMongoReliabilityRepository } from "../network-reliability/repository/mongoReliabilityRepository.js";
import { ReliabilityEventBus } from "../network-reliability/events/events.js";
import { ReliabilityMetrics } from "../network-reliability/observability/metrics.js";
import { ReliabilityMonitor } from "../network-reliability/monitoring/reliabilityMonitor.js";
import { HeartbeatMonitor } from "../network-reliability/heartbeat/heartbeatMonitor.js";
import { ReliabilityError } from "../network-reliability/errors.js";

/** Shared reliability event bus. Future Layer 8 subscribes here. */
export const reliabilityEvents = new ReliabilityEventBus();
const reliabilityMetrics = new ReliabilityMetrics();
const reliabilityRepo = createMongoReliabilityRepository();
export const reliabilityMonitor = new ReliabilityMonitor({ events: reliabilityEvents, metrics: reliabilityMetrics, sink: reliabilityRepo.alerts });
reliabilityMonitor.subscribe(reliabilityEvents);

/**
 * Server-side recovery hooks. The reliability layer tracks recovery state; the DEVICE drives the
 * actual transport reconnect + confirms via heartbeat, so the server hooks accept optimistically.
 */
const recoveryHooks = {
  resume: async () => false, // no server-side resume; force the device to reconnect + confirm
  reconnect: async () => true, // accept the device's reconnect (confirmed by a subsequent heartbeat)
  refreshCandidates: async () => true,
  switchRelay: async () => true,
  gracefulFail: async () => true,
};

/** Process-wide Network Reliability Manager. */
export const networkReliabilityManager = new NetworkReliabilityManager({
  ...reliabilityRepo,
  events: reliabilityEvents,
  metrics: reliabilityMetrics,
  monitor: reliabilityMonitor,
  recoveryHooks,
});

/** Background heartbeat monitor (periodic timeout sweeps). Started from server.js. */
export const reliabilityHeartbeatMonitor = new HeartbeatMonitor({ manager: networkReliabilityManager });

/** The stable facade the HTTP handlers delegate to. */
export const reliabilityApi = createReliabilityApi(networkReliabilityManager, { monitor: reliabilityMonitor, metrics: reliabilityMetrics, repository: reliabilityRepo.alerts });

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof ReliabilityError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, reason: error.reason });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/** POST /api/network-reliability/register — register an active connection. Body: { peerId, sessionId?, planId?, transport?, relayUsed?, selectedPair?, state?, retryPolicy? }. */
export const register = async (req, res) => {
  try {
    const connection = await reliabilityApi.register({ actingDevice: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, connection });
  } catch (error) {
    return handleError(res, error, "register");
  }
};

/** POST /api/network-reliability/:connectionId/heartbeat — heartbeat a connection. Body: { latencyMs? }. */
export const heartbeat = async (req, res) => {
  try {
    const connection = await reliabilityApi.heartbeat({ actingDevice: callerId(req), connectionId: req.params.connectionId, latencyMs: req.body?.latencyMs });
    return res.status(200).json({ success: true, connection });
  } catch (error) {
    return handleError(res, error, "heartbeat");
  }
};

/** POST /api/network-reliability/:connectionId/recover — recover a connection. Body: { trigger, retryPolicy? }. */
export const recover = async (req, res) => {
  try {
    const result = await reliabilityApi.recover({ actingDevice: callerId(req), connectionId: req.params.connectionId, trigger: req.body?.trigger, retryPolicy: req.body?.retryPolicy });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "recover");
  }
};

/** POST /api/network-reliability/:connectionId/reconnect — manual reconnect. */
export const reconnect = async (req, res) => {
  try {
    const result = await reliabilityApi.reconnect({ actingDevice: callerId(req), connectionId: req.params.connectionId, retryPolicy: req.body?.retryPolicy });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "reconnect");
  }
};

/** POST /api/network-reliability/:connectionId/network-event — report a network change. Body: { trigger }. */
export const networkEvent = async (req, res) => {
  try {
    const result = await reliabilityApi.reportNetworkEvent({ actingDevice: callerId(req), connectionId: req.params.connectionId, trigger: req.body?.trigger });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "networkEvent");
  }
};

/** POST /api/network-reliability/:connectionId/close — close a connection. */
export const close = async (req, res) => {
  try {
    const connection = await reliabilityApi.close({ actingDevice: callerId(req), connectionId: req.params.connectionId });
    return res.status(200).json({ success: true, connection });
  } catch (error) {
    return handleError(res, error, "close");
  }
};

/** GET /api/network-reliability/connection/:connectionId — a connection view. */
export const getConnection = async (req, res) => {
  try {
    const connection = await reliabilityApi.getConnection({ actingDevice: callerId(req), connectionId: req.params.connectionId });
    return res.status(200).json({ success: true, connection });
  } catch (error) {
    return handleError(res, error, "getConnection");
  }
};

/** GET /api/network-reliability/connection/:connectionId/health — a connection's health. */
export const getHealth = async (req, res) => {
  try {
    const health = await reliabilityApi.getHealth({ actingDevice: callerId(req), connectionId: req.params.connectionId });
    return res.status(200).json({ success: true, health });
  } catch (error) {
    return handleError(res, error, "getHealth");
  }
};

/** GET /api/network-reliability/connection/:connectionId/diagnostics — diagnostics + recovery history. */
export const getDiagnostics = async (req, res) => {
  try {
    const diagnostics = await reliabilityApi.getDiagnostics({ actingDevice: callerId(req), connectionId: req.params.connectionId, limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, diagnostics });
  } catch (error) {
    return handleError(res, error, "getDiagnostics");
  }
};

/** GET /api/network-reliability/connections — the caller's connections (`?limit=`). */
export const listConnections = async (req, res) => {
  try {
    const connections = await reliabilityApi.listConnections({ actingDevice: callerId(req), limit: req.query.limit });
    return res.status(200).json({ success: true, connections });
  } catch (error) {
    return handleError(res, error, "listConnections");
  }
};

/** GET /api/network-reliability/health — read-only control-plane health snapshot. */
export const health = async (req, res) => {
  try {
    return res.status(200).json({ success: true, health: await reliabilityApi.health() });
  } catch (error) {
    return handleError(res, error, "health");
  }
};

/** GET /api/network-reliability/metrics — metrics (JSON) or Prometheus (?format=prometheus). */
export const metrics = async (req, res) => {
  try {
    if (req.query?.format === "prometheus") {
      res.setHeader("Content-Type", "text/plain; version=0.0.4");
      return res.status(200).send(await reliabilityApi.prometheus());
    }
    return res.status(200).json({ success: true, metrics: await reliabilityApi.metrics() });
  } catch (error) {
    return handleError(res, error, "metrics");
  }
};

/** GET /api/network-reliability/alerts — recent alerts (paginated). */
export const alerts = async (req, res) => {
  try {
    const result = await reliabilityApi.alerts(req.query ?? {});
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "alerts");
  }
};

/** GET /api/network-reliability/protocol — the frozen protocol manifest. */
export const protocol = async (req, res) => {
  try {
    return res.status(200).json({ success: true, protocol: await reliabilityApi.protocol() });
  } catch (error) {
    return handleError(res, error, "protocol");
  }
};

/**
 * @module controllers/transportReliabilityController
 *
 * HTTP handlers for the **Data Plane Reliability** subsystem (Layer 8, Sprint 3), mounted at
 * `/api/transport-reliability`. Devices register their transfers for reliability tracking, report
 * progress checkpoints, and request recovery / resume / migration; the server tracks reliability
 * state + health, drives checkpoint-preserving recovery, and exposes READ-ONLY observability (health,
 * metrics, Prometheus, alerts, diagnostics, the frozen Data-Plane protocol manifest, security audit).
 *
 * This subsystem makes TRANSFERS reliable — it carries NO payload bytes or keys. Every route is JWT-
 * protected; `req.user._id` is the acting device (a transfer participant).
 *
 * @security Returns CONTROL-PLANE metadata + numeric aggregates only. Recovery + migration preserve
 * the transfer checkpoint (resume, never restart) and the crypto session (a migration is a transport
 * swap, not a re-handshake).
 *
 * @note The recovery / migration HOOKS here are server-side defaults: the reliability layer tracks +
 * orchestrates, while the DEVICE re-sends the missing chunks (Transport Engine) + Layer 7's Connection
 * Manager validates/switches the connection, confirming via a subsequent checkpoint. A deployment
 * wiring the real engines injects concrete hooks.
 */

import { TransportReliabilityManager } from "../transport-reliability/manager/transportReliabilityManager.js";
import { createReliabilityApi } from "../transport-reliability/api/reliabilityApi.js";
import { createMongoReliabilityRepository } from "../transport-reliability/repository/mongoReliabilityRepository.js";
import { TransferMetrics } from "../transport-reliability/monitoring/metrics.js";
import { TransportMonitor } from "../transport-reliability/monitoring/transportMonitor.js";
import { TransferHealthMonitor } from "../transport-reliability/monitoring/healthMonitor.js";
import { ReliabilityEventBus } from "../transport-reliability/events/events.js";
import { ReliabilityError } from "../transport-reliability/errors.js";

/** Shared reliability event bus. A future Layer 9 (offline sync) subscribes here. */
export const reliabilityEvents = new ReliabilityEventBus();
const reliabilityMetrics = new TransferMetrics();
const reliabilityRepo = createMongoReliabilityRepository();
export const transportMonitor = new TransportMonitor({ events: reliabilityEvents, metrics: reliabilityMetrics, sink: reliabilityRepo.alerts });

/**
 * Server-side recovery hooks. The reliability layer tracks state + resume plans; the DEVICE re-sends
 * the missing chunks + confirms via a subsequent checkpoint, so the hooks accept optimistically.
 */
const recoveryHooks = {
  resumeFromCheckpoint: async () => true, // device re-sends chunks >= the resume point + confirms
  retry: async () => true,
  gracefulFail: async () => true,
};

/** Server-side migration hooks. Layer 7's Connection Manager validates + switches the connection. */
const migrationHooks = {
  validateConnection: async () => true, // accept the device-reported new Active Connection
  switchConnection: async () => true,
};

/** Process-wide Data Plane Reliability Manager. */
export const transportReliabilityManager = new TransportReliabilityManager({
  ...reliabilityRepo,
  events: reliabilityEvents,
  metrics: reliabilityMetrics,
  monitor: transportMonitor,
  recoveryHooks,
  migrationHooks,
});

/** Background stall monitor (periodic no-progress sweeps). Started from server.js. */
export const stallMonitor = new TransferHealthMonitor({ manager: transportReliabilityManager });

/** The stable facade the HTTP handlers delegate to. */
export const reliabilityApi = createReliabilityApi(transportReliabilityManager, { metrics: reliabilityMetrics, monitor: transportMonitor, alerts: reliabilityRepo.alerts });

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof ReliabilityError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, reason: error.reason });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/** POST /api/transport-reliability/transfers — register a transfer for reliability tracking. */
export const register = async (req, res) => {
  try {
    const record = await reliabilityApi.register({ senderDeviceId: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, transfer: record });
  } catch (error) {
    return handleError(res, error, "register");
  }
};

/** POST /api/transport-reliability/transfers/:transferId/checkpoint — report progress. */
export const checkpoint = async (req, res) => {
  try {
    const record = await reliabilityApi.checkpoint({ transferId: req.params.transferId, ...(req.body ?? {}) });
    return res.status(200).json({ success: true, transfer: record });
  } catch (error) {
    return handleError(res, error, "checkpoint");
  }
};

/** POST /api/transport-reliability/transfers/:transferId/interrupt — flag an interruption. Body: { trigger, autoRecover? }. */
export const interrupt = async (req, res) => {
  try {
    const record = await reliabilityApi.reportInterruption({ transferId: req.params.transferId, actingDevice: callerId(req), trigger: req.body?.trigger, autoRecover: req.body?.autoRecover });
    return res.status(200).json({ success: true, transfer: record });
  } catch (error) {
    return handleError(res, error, "interrupt");
  }
};

/** POST /api/transport-reliability/transfers/:transferId/recover — recover. Body: { trigger, newConnectionId? }. */
export const recover = async (req, res) => {
  try {
    const result = await reliabilityApi.recover({ transferId: req.params.transferId, actingDevice: callerId(req), trigger: req.body?.trigger, newConnectionId: req.body?.newConnectionId });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "recover");
  }
};

/** POST /api/transport-reliability/transfers/:transferId/resume — resume from checkpoint. */
export const resume = async (req, res) => {
  try {
    const result = await reliabilityApi.resume({ transferId: req.params.transferId, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "resume");
  }
};

/** POST /api/transport-reliability/transfers/:transferId/migrate — migrate to a new connection. Body: { newConnectionId, trigger? }. */
export const migrate = async (req, res) => {
  try {
    const record = await reliabilityApi.migrate({ transferId: req.params.transferId, actingDevice: callerId(req), newConnectionId: req.body?.newConnectionId, trigger: req.body?.trigger });
    return res.status(200).json({ success: true, transfer: record });
  } catch (error) {
    return handleError(res, error, "migrate");
  }
};

/** POST /api/transport-reliability/transfers/:transferId/complete — mark completed. */
export const complete = async (req, res) => {
  try {
    const record = await reliabilityApi.complete({ transferId: req.params.transferId, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, transfer: record });
  } catch (error) {
    return handleError(res, error, "complete");
  }
};

/** POST /api/transport-reliability/transfers/:transferId/abandon — abandon/cancel. */
export const abandon = async (req, res) => {
  try {
    const record = await reliabilityApi.abandon({ transferId: req.params.transferId, actingDevice: callerId(req), reason: req.body?.reason });
    return res.status(200).json({ success: true, transfer: record });
  } catch (error) {
    return handleError(res, error, "abandon");
  }
};

/** GET /api/transport-reliability/transfers/:transferId — a transfer's reliability record. */
export const getTransfer = async (req, res) => {
  try {
    const record = await reliabilityApi.getRecord({ transferId: req.params.transferId, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, transfer: record });
  } catch (error) {
    return handleError(res, error, "getTransfer");
  }
};

/** GET /api/transport-reliability/transfers/:transferId/health — a transfer's live health. */
export const getHealth = async (req, res) => {
  try {
    const health = await reliabilityApi.getHealth({ transferId: req.params.transferId });
    return res.status(200).json({ success: true, health });
  } catch (error) {
    return handleError(res, error, "getHealth");
  }
};

/** GET /api/transport-reliability/transfers/:transferId/diagnostics — full diagnostics. */
export const getDiagnostics = async (req, res) => {
  try {
    const diagnostics = await reliabilityApi.getDiagnostics({ transferId: req.params.transferId, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, diagnostics });
  } catch (error) {
    return handleError(res, error, "getDiagnostics");
  }
};

/** GET /api/transport-reliability/transfers — the caller's transfers (?state=). */
export const listTransfers = async (req, res) => {
  try {
    const transfers = await reliabilityApi.listTransfers({ deviceId: callerId(req), state: req.query.state, limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, transfers });
  } catch (error) {
    return handleError(res, error, "listTransfers");
  }
};

/** GET /api/transport-reliability/health — aggregate control-plane health. */
export const health = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, health: await reliabilityApi.health() });
  } catch (error) {
    return handleError(res, error, "health");
  }
};

/** GET /api/transport-reliability/metrics — metrics (JSON) or Prometheus (?format=prometheus). */
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

/** GET /api/transport-reliability/alerts — recent alerts (paginated). */
export const alerts = async (req, res) => {
  try {
    const result = await reliabilityApi.alerts(req.query ?? {});
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "alerts");
  }
};

/** GET /api/transport-reliability/protocol — the frozen Data-Plane protocol manifest. */
export const protocol = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, protocol: await reliabilityApi.protocol() });
  } catch (error) {
    return handleError(res, error, "protocol");
  }
};

/** GET /api/transport-reliability/security-audit — the Data-Plane security posture + assumptions. */
export const securityAudit = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, audit: await reliabilityApi.securityAudit() });
  } catch (error) {
    return handleError(res, error, "securityAudit");
  }
};

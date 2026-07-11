/**
 * @module controllers/syncReliabilityController
 *
 * HTTP handlers for the **Synchronization Reliability** subsystem (Layer 9, Sprint 3), mounted at
 * `/api/sync-reliability`. Devices register their synchronization sessions for reliability tracking,
 * report progress checkpoints, and request recovery / resume; the server tracks reliability state +
 * health + replica drift, drives checkpoint-preserving recovery, and exposes READ-ONLY observability
 * (health, metrics, Prometheus, alerts, diagnostics, the frozen protocol manifest, security audit).
 *
 * This subsystem makes SYNCHRONIZATION reliable — it carries NO message content or keys. Every route is
 * JWT-protected; `req.user._id` is the acting device (owner-scoped).
 *
 * @security Returns CONTROL-PLANE metadata + numeric aggregates only. Recovery preserves replica
 * consistency (the monotonic checkpoint) so a resume re-runs only the remaining operations.
 *
 * @note The recovery HOOKS here are server-side defaults: the reliability layer tracks + orchestrates,
 * while the DEVICE re-runs the remaining operations (Sprint 1/2 engines + Layer 8 for attachments),
 * confirming via a subsequent checkpoint. A deployment wiring the real engines injects concrete hooks.
 */

import { SyncReliabilityManager } from "../synchronization-reliability/manager/syncReliabilityManager.js";
import { createReliabilityApi } from "../synchronization-reliability/api/reliabilityApi.js";
import { createMongoReliabilityRepository } from "../synchronization-reliability/repository/mongoReliabilityRepository.js";
import { SyncMetrics } from "../synchronization-reliability/monitoring/metrics.js";
import { SyncMonitor } from "../synchronization-reliability/monitoring/syncMonitor.js";
import { SyncHealthMonitor } from "../synchronization-reliability/health/healthMonitor.js";
import { ReliabilityEventBus } from "../synchronization-reliability/events/events.js";
import { SyncReliabilityError } from "../synchronization-reliability/errors.js";

/** Shared reliability event bus. A future Layer 10 subscribes here. */
export const syncReliabilityEvents = new ReliabilityEventBus();
const syncMetrics = new SyncMetrics();
const syncReliabilityRepo = createMongoReliabilityRepository();
export const syncMonitor = new SyncMonitor({ events: syncReliabilityEvents, metrics: syncMetrics, sink: syncReliabilityRepo.alerts });

/** Server-side recovery hooks (optimistic: the device re-runs remaining ops + confirms via checkpoint). */
const recoveryHooks = {
  resumeFromCheckpoint: async () => true,
  retry: async () => true,
  restart: async () => true,
  gracefulFail: async () => true,
};

/** Process-wide Synchronization Reliability Manager. */
export const syncReliabilityManager = new SyncReliabilityManager({ ...syncReliabilityRepo, events: syncReliabilityEvents, metrics: syncMetrics, monitor: syncMonitor, recoveryHooks });

/** Background stall monitor (periodic no-progress sweeps). Started from server.js. */
export const stallMonitor = new SyncHealthMonitor({ manager: syncReliabilityManager });

/** The stable facade the HTTP handlers delegate to. */
export const reliabilityApi = createReliabilityApi(syncReliabilityManager, { metrics: syncMetrics, monitor: syncMonitor, alerts: syncReliabilityRepo.alerts });

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof SyncReliabilityError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, reason: error.reason });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/** POST /api/sync-reliability/syncs — register a synchronization for reliability tracking. */
export const register = async (req, res) => {
  try {
    const record = await reliabilityApi.register({ deviceId: callerId(req), userId: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, sync: record });
  } catch (error) {
    return handleError(res, error, "register");
  }
};

/** POST /api/sync-reliability/syncs/:syncId/checkpoint — report progress. */
export const checkpoint = async (req, res) => {
  try {
    const record = await reliabilityApi.checkpoint({ syncId: req.params.syncId, ...(req.body ?? {}) });
    return res.status(200).json({ success: true, sync: record });
  } catch (error) {
    return handleError(res, error, "checkpoint");
  }
};

/** POST /api/sync-reliability/syncs/:syncId/interrupt — flag an interruption. Body: { trigger, autoRecover? }. */
export const interrupt = async (req, res) => {
  try {
    const record = await reliabilityApi.reportInterruption({ syncId: req.params.syncId, actingDevice: callerId(req), trigger: req.body?.trigger, autoRecover: req.body?.autoRecover });
    return res.status(200).json({ success: true, sync: record });
  } catch (error) {
    return handleError(res, error, "interrupt");
  }
};

/** POST /api/sync-reliability/syncs/:syncId/recover — recover. Body: { trigger }. */
export const recover = async (req, res) => {
  try {
    const result = await reliabilityApi.recover({ syncId: req.params.syncId, actingDevice: callerId(req), trigger: req.body?.trigger });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "recover");
  }
};

/** POST /api/sync-reliability/syncs/:syncId/resume — resume from checkpoint. */
export const resume = async (req, res) => {
  try {
    const result = await reliabilityApi.resume({ syncId: req.params.syncId, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "resume");
  }
};

/** POST /api/sync-reliability/syncs/:syncId/complete — mark completed. */
export const complete = async (req, res) => {
  try {
    const record = await reliabilityApi.complete({ syncId: req.params.syncId, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, sync: record });
  } catch (error) {
    return handleError(res, error, "complete");
  }
};

/** POST /api/sync-reliability/syncs/:syncId/abandon — abandon. */
export const abandon = async (req, res) => {
  try {
    const record = await reliabilityApi.abandon({ syncId: req.params.syncId, actingDevice: callerId(req), reason: req.body?.reason });
    return res.status(200).json({ success: true, sync: record });
  } catch (error) {
    return handleError(res, error, "abandon");
  }
};

/** GET /api/sync-reliability/syncs/:syncId — a sync's reliability record. */
export const getSync = async (req, res) => {
  try {
    const record = await reliabilityApi.getRecord({ syncId: req.params.syncId, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, sync: record });
  } catch (error) {
    return handleError(res, error, "getSync");
  }
};

/** GET /api/sync-reliability/syncs/:syncId/health — a sync's live health. */
export const getHealth = async (req, res) => {
  try {
    const health = await reliabilityApi.getHealth({ syncId: req.params.syncId });
    return res.status(200).json({ success: true, health });
  } catch (error) {
    return handleError(res, error, "getHealth");
  }
};

/** GET /api/sync-reliability/syncs/:syncId/diagnostics — full diagnostics. */
export const getDiagnostics = async (req, res) => {
  try {
    const diagnostics = await reliabilityApi.getDiagnostics({ syncId: req.params.syncId, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, diagnostics });
  } catch (error) {
    return handleError(res, error, "getDiagnostics");
  }
};

/** GET /api/sync-reliability/syncs — the caller's syncs (?state=). */
export const listSyncs = async (req, res) => {
  try {
    const syncs = await reliabilityApi.listSyncs({ userId: callerId(req), state: req.query.state, limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, syncs });
  } catch (error) {
    return handleError(res, error, "listSyncs");
  }
};

/** GET /api/sync-reliability/health — aggregate control-plane health. */
export const health = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, health: await reliabilityApi.health() });
  } catch (error) {
    return handleError(res, error, "health");
  }
};

/** GET /api/sync-reliability/metrics — metrics (JSON) or Prometheus (?format=prometheus). */
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

/** GET /api/sync-reliability/alerts — recent alerts (paginated). */
export const alerts = async (req, res) => {
  try {
    const result = await reliabilityApi.alerts(req.query ?? {});
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "alerts");
  }
};

/** GET /api/sync-reliability/protocol — the frozen synchronization-layer protocol manifest. */
export const protocol = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, protocol: await reliabilityApi.protocol() });
  } catch (error) {
    return handleError(res, error, "protocol");
  }
};

/** GET /api/sync-reliability/security-audit — the synchronization security posture + assumptions. */
export const securityAudit = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, audit: await reliabilityApi.securityAudit() });
  } catch (error) {
    return handleError(res, error, "securityAudit");
  }
};

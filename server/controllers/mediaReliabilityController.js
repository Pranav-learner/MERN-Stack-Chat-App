/**
 * @module controllers/mediaReliabilityController
 *
 * HTTP handlers for the **Media Reliability** subsystem (Layer 11, Sprint 3), mounted at
 * `/api/media-reliability`. Devices register their media operations (upload / download / streaming /
 * synchronization / pipeline) for reliability tracking, report progress checkpoints, and request recovery
 * / resume; the server tracks reliability state + health + backlog, drives checkpoint-preserving
 * recovery, and exposes READ-ONLY observability (health per-operation + per-media, metrics, Prometheus,
 * alerts, diagnostics, audit trail, the frozen protocol manifest, security audit).
 *
 * This subsystem makes MEDIA operations reliable — it carries NO media content or keys. Every route is
 * JWT-protected; `req.user._id` is the acting device (owner-scoped), and every mutating op is audited.
 *
 * @note The recovery HOOKS here are server-side defaults: the reliability layer tracks + orchestrates,
 * while the Sprint-1/2 engine re-runs the remaining chunks (resume a progressive transfer / re-run a
 * pipeline stage / re-buffer a stream), confirming via a subsequent checkpoint. A deployment wiring the
 * real engine injects concrete hooks.
 */

import { MediaReliabilityManager } from "../media-reliability/manager/mediaReliabilityManager.js";
import { createMediaReliabilityApi } from "../media-reliability/api/reliabilityApi.js";
import { createMongoMediaReliabilityRepository } from "../media-reliability/repository/mongoMediaReliabilityRepository.js";
import { MediaMetrics } from "../media-reliability/monitoring/metrics.js";
import { MediaMonitor } from "../media-reliability/monitoring/mediaMonitor.js";
import { MediaCache } from "../media-reliability/cache/mediaCache.js";
import { MediaHealthMonitor } from "../media-reliability/health/healthMonitor.js";
import { MediaReliabilityEventBus } from "../media-reliability/events/events.js";
import { MediaReliabilityError } from "../media-reliability/errors.js";

/** Shared reliability event bus. A future Layer 12 subscribes here. */
export const mediaReliabilityEvents = new MediaReliabilityEventBus();
const mediaMetrics = new MediaMetrics();
const mediaReliabilityRepo = createMongoMediaReliabilityRepository();
export const mediaMonitor = new MediaMonitor({ events: mediaReliabilityEvents, metrics: mediaMetrics, sink: mediaReliabilityRepo.alerts });
export const mediaCache = new MediaCache({ metrics: mediaMetrics });

/** Server-side recovery hooks (optimistic: the Sprint-1/2 engine re-runs remaining chunks + confirms). */
const recoveryHooks = {
  resumeFromCheckpoint: async () => true,
  retry: async () => true,
  replan: async () => true,
  gracefulFail: async () => true,
};

/** Process-wide Media Reliability Manager. */
export const mediaReliabilityManager = new MediaReliabilityManager({ ...mediaReliabilityRepo, events: mediaReliabilityEvents, metrics: mediaMetrics, monitor: mediaMonitor, cache: mediaCache, recoveryHooks });

/** Background stall monitor (periodic no-progress sweeps → recovery). Started from server.js. */
export const stallMonitor = new MediaHealthMonitor({ manager: mediaReliabilityManager });

/** The stable facade the HTTP handlers delegate to. */
export const mediaReliabilityApi = createMediaReliabilityApi(mediaReliabilityManager, { metrics: mediaMetrics, monitor: mediaMonitor, alerts: mediaReliabilityRepo.alerts, audit: mediaReliabilityRepo.audit });

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof MediaReliabilityError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, reason: error.reason, details: error.details });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

const wrap = (fn, where) => async (req, res) => {
  try {
    return res.status(where.status ?? 200).json({ success: true, ...(await fn(req)) });
  } catch (error) {
    return handleError(res, error, where.name);
  }
};

// === operation lifecycle ====================================================

export const registerOperation = wrap(async (req) => ({ operation: await mediaReliabilityApi.register({ deviceId: callerId(req), userId: callerId(req), ...(req.body ?? {}) }) }), { name: "registerOperation", status: 201 });
export const checkpoint = wrap(async (req) => ({ operation: await mediaReliabilityApi.checkpoint({ operationId: req.params.operationId, ...(req.body ?? {}) }) }), { name: "checkpoint" });
export const complete = wrap(async (req) => ({ operation: await mediaReliabilityApi.complete({ operationId: req.params.operationId, actingDevice: callerId(req) }) }), { name: "complete" });
export const reportInterruption = wrap(async (req) => ({ operation: await mediaReliabilityApi.reportInterruption({ operationId: req.params.operationId, trigger: req.body?.trigger, actingDevice: callerId(req), autoRecover: req.body?.autoRecover }) }), { name: "reportInterruption" });
export const recover = wrap((req) => mediaReliabilityApi.recover({ operationId: req.params.operationId, trigger: req.body?.trigger, actingDevice: callerId(req) }), { name: "recover" });
export const resume = wrap((req) => mediaReliabilityApi.resume({ operationId: req.params.operationId, actingDevice: callerId(req) }), { name: "resume" });
export const abandon = wrap(async (req) => ({ operation: await mediaReliabilityApi.abandon({ operationId: req.params.operationId, actingDevice: callerId(req), reason: req.body?.reason }) }), { name: "abandon" });

// === reads + observability ==================================================

export const getRecord = wrap(async (req) => ({ operation: await mediaReliabilityApi.getRecord({ operationId: req.params.operationId, actingDevice: callerId(req) }) }), { name: "getRecord" });
export const getDiagnostics = wrap(async (req) => ({ diagnostics: await mediaReliabilityApi.getDiagnostics({ operationId: req.params.operationId, actingDevice: callerId(req) }) }), { name: "getDiagnostics" });
export const listOperations = wrap(async (req) => ({ operations: await mediaReliabilityApi.listOperations({ userId: callerId(req), state: req.query.state, limit: req.query.limit ? Number(req.query.limit) : undefined }) }), { name: "listOperations" });
export const getMediaHealth = wrap(async (req) => ({ health: await mediaReliabilityApi.getMediaHealth({ mediaId: req.params.mediaId }) }), { name: "getMediaHealth" });
export const getMediaAudit = wrap(async (req) => ({ audit: await mediaReliabilityApi.auditTrail({ mediaId: req.params.mediaId, limit: req.query.limit ? Number(req.query.limit) : undefined }) }), { name: "getMediaAudit" });
export const health = wrap(async () => ({ health: await mediaReliabilityApi.health() }), { name: "health" });
export const metrics = wrap(async () => ({ metrics: mediaReliabilityApi.metrics() }), { name: "metrics" });
export const alerts = wrap(async (req) => mediaReliabilityApi.alerts({ limit: req.query.limit, offset: req.query.offset }), { name: "alerts" });
export const protocol = wrap(async () => ({ protocol: mediaReliabilityApi.protocol() }), { name: "protocol" });
export const securityAudit = wrap(async () => ({ security: mediaReliabilityApi.securityAudit() }), { name: "securityAudit" });

export const prometheus = async (_req, res) => {
  try {
    res.setHeader("Content-Type", "text/plain; version=0.0.4");
    return res.status(200).send(mediaReliabilityApi.prometheus());
  } catch (error) {
    return handleError(res, error, "prometheus");
  }
};

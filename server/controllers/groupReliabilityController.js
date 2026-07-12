/**
 * @module controllers/groupReliabilityController
 *
 * HTTP handlers for the **Group Reliability** subsystem (Layer 10, Sprint 3), mounted at
 * `/api/group-reliability`. Devices register their group operations (group-message / fan-out / rekey /
 * membership-update / replica-sync / offline-delivery) for reliability tracking, report progress
 * checkpoints, and request recovery / resume; the server tracks reliability state + health + backlog,
 * drives checkpoint-preserving recovery, and exposes READ-ONLY observability (health per-operation +
 * per-group, metrics, Prometheus, alerts, diagnostics, audit trail, the frozen protocol manifest,
 * security audit).
 *
 * This subsystem makes GROUP COMMUNICATION reliable — it carries NO message content or keys. Every route
 * is JWT-protected; `req.user._id` is the acting device (owner-scoped), and every mutating op is audited.
 *
 * @note The recovery HOOKS here are server-side defaults: the reliability layer tracks + orchestrates,
 * while the Sprint-2 engine re-runs the remaining targets (re-send failed fan-out legs / re-distribute a
 * rekey / resume a group sync), confirming via a subsequent checkpoint. A deployment wiring the real
 * engine injects concrete hooks.
 */

import { GroupReliabilityManager } from "../group-reliability/manager/groupReliabilityManager.js";
import { createGroupReliabilityApi } from "../group-reliability/api/reliabilityApi.js";
import { createMongoGroupReliabilityRepository } from "../group-reliability/repository/mongoGroupReliabilityRepository.js";
import { GroupMetrics } from "../group-reliability/monitoring/metrics.js";
import { GroupMonitor } from "../group-reliability/monitoring/groupMonitor.js";
import { GroupHealthMonitor } from "../group-reliability/health/healthMonitor.js";
import { GroupReliabilityEventBus } from "../group-reliability/events/events.js";
import { GroupReliabilityError } from "../group-reliability/errors.js";

/** Shared reliability event bus. A future Sprint 4 subscribes here. */
export const groupReliabilityEvents = new GroupReliabilityEventBus();
const groupMetrics = new GroupMetrics();
const groupReliabilityRepo = createMongoGroupReliabilityRepository();
export const groupMonitor = new GroupMonitor({ events: groupReliabilityEvents, metrics: groupMetrics, sink: groupReliabilityRepo.alerts });

/** Server-side recovery hooks (optimistic: the Sprint-2 engine re-runs remaining targets + confirms). */
const recoveryHooks = {
  resumeFromCheckpoint: async () => true,
  retry: async () => true,
  replan: async () => true,
  gracefulFail: async () => true,
};

/** Process-wide Group Reliability Manager. */
export const groupReliabilityManager = new GroupReliabilityManager({ ...groupReliabilityRepo, events: groupReliabilityEvents, metrics: groupMetrics, monitor: groupMonitor, recoveryHooks });

/** Background stall monitor (periodic no-progress sweeps → recovery). Started from server.js. */
export const stallMonitor = new GroupHealthMonitor({ manager: groupReliabilityManager });

/** The stable facade the HTTP handlers delegate to. */
export const groupReliabilityApi = createGroupReliabilityApi(groupReliabilityManager, { metrics: groupMetrics, monitor: groupMonitor, alerts: groupReliabilityRepo.alerts, audit: groupReliabilityRepo.audit });

const callerId = (req) => String(req.user._id);

function handleError(res, error, where) {
  if (error instanceof GroupReliabilityError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, reason: error.reason, details: error.details });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

// === operation lifecycle ====================================================

/** POST /operations — register a group operation for reliability tracking. */
export const registerOperation = async (req, res) => {
  try {
    const record = await groupReliabilityApi.register({ deviceId: callerId(req), userId: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, operation: record });
  } catch (error) {
    return handleError(res, error, "registerOperation");
  }
};

/** POST /operations/:operationId/checkpoint — report progress. */
export const checkpoint = async (req, res) => {
  try {
    const record = await groupReliabilityApi.checkpoint({ operationId: req.params.operationId, ...(req.body ?? {}) });
    return res.status(200).json({ success: true, operation: record });
  } catch (error) {
    return handleError(res, error, "checkpoint");
  }
};

/** POST /operations/:operationId/complete — mark completed. */
export const complete = async (req, res) => {
  try {
    const record = await groupReliabilityApi.complete({ operationId: req.params.operationId, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, operation: record });
  } catch (error) {
    return handleError(res, error, "complete");
  }
};

/** POST /operations/:operationId/interrupt — flag interrupted (?autoRecover). Body: { trigger }. */
export const reportInterruption = async (req, res) => {
  try {
    const record = await groupReliabilityApi.reportInterruption({ operationId: req.params.operationId, trigger: req.body?.trigger, actingDevice: callerId(req), autoRecover: req.body?.autoRecover });
    return res.status(200).json({ success: true, operation: record });
  } catch (error) {
    return handleError(res, error, "reportInterruption");
  }
};

/** POST /operations/:operationId/recover — run a recovery. Body: { trigger }. */
export const recover = async (req, res) => {
  try {
    const result = await groupReliabilityApi.recover({ operationId: req.params.operationId, trigger: req.body?.trigger, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "recover");
  }
};

/** POST /operations/:operationId/resume — resume from checkpoint. */
export const resume = async (req, res) => {
  try {
    const result = await groupReliabilityApi.resume({ operationId: req.params.operationId, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "resume");
  }
};

/** POST /operations/:operationId/abandon — cancel. */
export const abandon = async (req, res) => {
  try {
    const record = await groupReliabilityApi.abandon({ operationId: req.params.operationId, actingDevice: callerId(req), reason: req.body?.reason });
    return res.status(200).json({ success: true, operation: record });
  } catch (error) {
    return handleError(res, error, "abandon");
  }
};

// === reads + observability ==================================================

/** GET /operations/:operationId — a reliability record. */
export const getRecord = async (req, res) => {
  try {
    const record = await groupReliabilityApi.getRecord({ operationId: req.params.operationId, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, operation: record });
  } catch (error) {
    return handleError(res, error, "getRecord");
  }
};

/** GET /operations/:operationId/diagnostics — full diagnostics. */
export const getDiagnostics = async (req, res) => {
  try {
    const diagnostics = await groupReliabilityApi.getDiagnostics({ operationId: req.params.operationId, actingDevice: callerId(req) });
    return res.status(200).json({ success: true, diagnostics });
  } catch (error) {
    return handleError(res, error, "getDiagnostics");
  }
};

/** GET /operations — list the caller's operations (?state=&limit=). */
export const listOperations = async (req, res) => {
  try {
    const operations = await groupReliabilityApi.listOperations({ userId: callerId(req), state: req.query.state, limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, operations });
  } catch (error) {
    return handleError(res, error, "listOperations");
  }
};

/** GET /groups/:groupId/health — aggregate reliability health for a group. */
export const getGroupHealth = async (req, res) => {
  try {
    const health = await groupReliabilityApi.getGroupHealth({ groupId: req.params.groupId });
    return res.status(200).json({ success: true, health });
  } catch (error) {
    return handleError(res, error, "getGroupHealth");
  }
};

/** GET /groups/:groupId/audit — group audit trail (?limit=). */
export const getGroupAudit = async (req, res) => {
  try {
    const audit = await groupReliabilityApi.auditTrail({ groupId: req.params.groupId, limit: req.query.limit ? Number(req.query.limit) : undefined });
    return res.status(200).json({ success: true, audit });
  } catch (error) {
    return handleError(res, error, "getGroupAudit");
  }
};

/** GET /health — aggregate control-plane health. */
export const health = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, health: await groupReliabilityApi.health() });
  } catch (error) {
    return handleError(res, error, "health");
  }
};

/** GET /metrics — metrics snapshot (JSON). */
export const metrics = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, metrics: groupReliabilityApi.metrics() });
  } catch (error) {
    return handleError(res, error, "metrics");
  }
};

/** GET /metrics/prometheus — Prometheus text exposition. */
export const prometheus = async (_req, res) => {
  try {
    res.setHeader("Content-Type", "text/plain; version=0.0.4");
    return res.status(200).send(groupReliabilityApi.prometheus());
  } catch (error) {
    return handleError(res, error, "prometheus");
  }
};

/** GET /alerts — recent alerts (?limit=&offset=). */
export const alerts = async (req, res) => {
  try {
    const result = await groupReliabilityApi.alerts({ limit: req.query.limit, offset: req.query.offset });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "alerts");
  }
};

/** GET /protocol — the frozen protocol manifest + extension points. */
export const protocol = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, protocol: groupReliabilityApi.protocol() });
  } catch (error) {
    return handleError(res, error, "protocol");
  }
};

/** GET /security-audit — the security posture + assumptions. */
export const securityAudit = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, security: groupReliabilityApi.securityAudit() });
  } catch (error) {
    return handleError(res, error, "securityAudit");
  }
};

/**
 * @module controllers/fabricReliabilityController
 *
 * HTTP handlers for the **Production Communication Fabric** reliability layer (Layer 12, Sprint 4), mounted
 * at `/api/fabric-reliability`. It exposes the operational tooling — liveness / readiness / health,
 * diagnostics, metrics (JSON + Prometheus), per-operation inspection, runtime status, and the frozen
 * architecture manifest — for the whole Communication Fabric. It also EXPORTS the process-wide reliability
 * manager (used to wrap the fabric's execute) + a stall monitor the server starts, mirroring every prior
 * `*-reliability` layer.
 *
 * @security The reliability layer reasons over control-plane operation metadata only — never content/keys.
 * Health/metrics endpoints are JWT-protected (operational data). Liveness/readiness are lightweight.
 */

import { FabricReliabilityManager } from "../fabric-reliability/manager/reliabilityManager.js";
import { createReliabilityApi } from "../fabric-reliability/api/reliabilityApi.js";
import { createMongoReliabilityRepository } from "../fabric-reliability/repository/mongoReliabilityRepository.js";
import { FabricReliabilityEventBus } from "../fabric-reliability/events/events.js";
import { ReliabilityError } from "../fabric-reliability/errors.js";
import { fabricEvents } from "./communicationFabricController.js";
import { adaptiveEvents } from "./adaptiveRoutingController.js";
import { optimizationEvents } from "./optimizationController.js";

/** Shared reliability event bus (a future admin/monitoring UI subscribes here). */
export const reliabilityEvents = new FabricReliabilityEventBus();

/** Process-wide Fabric Reliability Manager over the Mongo-backed repository. */
export const fabricReliabilityManager = new FabricReliabilityManager({ ...createMongoReliabilityRepository(), events: reliabilityEvents });

/** The stable facade the HTTP handlers delegate to. */
export const reliabilityApi = createReliabilityApi(fabricReliabilityManager);

// Attach the monitor to the frozen lower-layer buses so their events become fabric metrics (no coupling —
// routed by event `type` prefix). This is the Sprint-4 consumption of the Sprint 1/2/3 event streams.
fabricReliabilityManager.attachBus(fabricEvents);
fabricReliabilityManager.attachBus(adaptiveEvents);
fabricReliabilityManager.attachBus(optimizationEvents);

/**
 * The stall monitor — periodic sweep (recovery stall-sweep + health check + threshold alerts + a health
 * snapshot). The timer is unref'd so it never keeps the process alive. server.js starts it, mirroring the
 * transport/sync/group/media reliability stall monitors.
 */
export const stallMonitor = {
  _started: false,
  start() {
    if (this._started) return;
    this._started = true;
    fabricReliabilityManager.monitor.start();
    // periodically persist a health snapshot for operational history (unref'd)
    this._snapTimer = setInterval(() => {
      fabricReliabilityManager.recordHealthSnapshot().catch(() => {});
    }, 60_000);
    if (typeof this._snapTimer?.unref === "function") this._snapTimer.unref();
  },
};

function handleError(res, error, where) {
  if (error instanceof ReliabilityError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, reason: error.reason, failureClass: error.failureClass, details: error.details });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

/** GET /live — liveness probe (is the process up?). */
export const live = async (_req, res) => {
  try {
    const liveness = reliabilityApi.live();
    return res.status(liveness.live ? 200 : 503).json({ success: liveness.live, liveness });
  } catch (error) {
    return handleError(res, error, "live");
  }
};

/** GET /ready — readiness probe (can the platform accept traffic?). */
export const ready = async (_req, res) => {
  try {
    const readiness = await reliabilityApi.ready();
    return res.status(readiness.ready ? 200 : 503).json({ success: readiness.ready, readiness });
  } catch (error) {
    return handleError(res, error, "ready");
  }
};

/** GET /health — overall + per-component health. */
export const health = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, health: await reliabilityApi.health() });
  } catch (error) {
    return handleError(res, error, "health");
  }
};

/** GET /diagnostics — full diagnostics overview. */
export const diagnostics = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, diagnostics: await reliabilityApi.diagnostics() });
  } catch (error) {
    return handleError(res, error, "diagnostics");
  }
};

/** GET /metrics — metrics snapshot (JSON), or Prometheus text with ?format=prometheus. */
export const metrics = async (req, res) => {
  try {
    if (req.query.format === "prometheus") {
      res.setHeader("Content-Type", "text/plain; version=0.0.4");
      return res.status(200).send(reliabilityApi.prometheus());
    }
    return res.status(200).json({ success: true, metrics: reliabilityApi.metrics() });
  } catch (error) {
    return handleError(res, error, "metrics");
  }
};

/** GET /operations/:operationId — inspect a single operation (checkpoint + audit). */
export const inspectOperation = async (req, res) => {
  try {
    return res.status(200).json({ success: true, operation: await reliabilityApi.inspectOperation({ operationId: req.params.operationId }) });
  } catch (error) {
    return handleError(res, error, "inspectOperation");
  }
};

/** GET /status — runtime status / statistics. */
export const status = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, status: await reliabilityApi.status() });
  } catch (error) {
    return handleError(res, error, "status");
  }
};

/** GET /freeze — the frozen architecture manifest (stable APIs + extension points). */
export const freeze = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, freeze: reliabilityApi.freeze() });
  } catch (error) {
    return handleError(res, error, "freeze");
  }
};

/**
 * Client Resource Optimization integration (Layer 12, Sprint 3).
 *
 * Drives the `/api/optimization` subsystem: hand it a communication request (plus optional QoS / mode /
 * window / device / cost hints) and it returns the GLOBAL optimization — the QoS class + lane, the
 * scheduling decision (immediate / deferred / background / batch), the resource allocation, the
 * cross-device coordination plan, the workload-balance snapshot, and the optimized execution plan with an
 * execution timeline. A UI can show *when* a message will send, *which device* sends it, and *why* it was
 * deferred under load.
 *
 * The application still SENDS through the Communication Fabric (`/api/communication-fabric`) — which this
 * sprint makes globally optimized automatically. Use this client to preview scheduling, inspect the
 * scheduler/queue state, drain deferred work, or drive an optimization dashboard.
 *
 * @security This lib exchanges communication CONTROL-PLANE metadata + abstract resource UNITS only — never
 * message content or keys, and never real device/OS resources.
 *
 * @example
 * ```js
 * import { OptimizationClient } from "../lib/optimization.js";
 * const opt = new OptimizationClient({ axios });
 * const r = await opt.schedule({ type: "media-transfer", recipients: [bobId], mediaType: "video", payloadRef: { id, size } });
 * // r.qos.qosClass === "normal"; r.scheduling.mode === "batch"; r.optimizedPlan.timeline …
 * ```
 */

const BASE = "/api/optimization";

/** QoS class constants (mirror the server `QoSClass`). */
export const QOS = Object.freeze({ CRITICAL: "critical", HIGH: "high", NORMAL: "normal", BACKGROUND: "background" });

/** Scheduling mode constants (mirror the server `SchedulingMode`). */
export const MODE = Object.freeze({ IMMEDIATE: "immediate", DEFERRED: "deferred", BACKGROUND: "background", BATCH: "batch", PARALLEL: "parallel", SEQUENTIAL: "sequential" });

export class OptimizationClient {
  /** @param {object} deps @param {import("axios").AxiosInstance} deps.axios auth-bearing axios instance */
  constructor(deps) {
    if (!deps?.axios) throw new Error("OptimizationClient requires { axios }");
    this.axios = deps.axios;
  }

  /**
   * Full global optimization of a communication. `senderId` is taken from the caller server-side.
   * @param {object} request a communication request + optional `{ qosClass, mode, window, devices, cost, policyOverrides }`
   * @returns {Promise<object>} `{ qos, resources, scheduling, allocation, coordination, balance, optimizedPlan, status, proceed }`
   */
  async schedule(request) {
    const { data } = await this.axios.post(`${BASE}/schedule`, request);
    return data.result;
  }

  /** The optimized execution plan (dry run). */
  async getExecutionPlan(request) {
    const { data } = await this.axios.post(`${BASE}/execution-plan`, request);
    return data.plan;
  }

  /** The QoS profile (dry run). */
  async getQoSProfile(request) {
    const { data } = await this.axios.post(`${BASE}/qos`, request);
    return data.qos;
  }

  /** The resource allocation recommendation (dry run). */
  async getResourceAllocation(request) {
    const { data } = await this.axios.post(`${BASE}/resource-allocation`, request);
    return data.allocation;
  }

  /** The current scheduler + workload-balancer state (for a dashboard). */
  async getSchedulerState() {
    const { data } = await this.axios.get(`${BASE}/scheduler-state`);
    return data.state;
  }

  /** Drain ready queued work (adaptive dispatch). */
  async dispatch(maxConcurrent) {
    const { data } = await this.axios.post(`${BASE}/dispatch`, { maxConcurrent });
    return data.dispatch;
  }

  /** Optimization diagnostics + audit trail for a request. */
  async getDiagnostics(requestId) {
    const { data } = await this.axios.get(`${BASE}/diagnostics/${encodeURIComponent(requestId)}`);
    return data.diagnostics;
  }

  /** Fabric optimization status / health (budgets · lanes · metrics). */
  async status() {
    const { data } = await this.axios.get(`${BASE}/status`);
    return data.status;
  }
}

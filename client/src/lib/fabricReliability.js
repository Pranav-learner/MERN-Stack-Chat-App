/**
 * Client Production Fabric Reliability integration (Layer 12, Sprint 4).
 *
 * Drives the `/api/fabric-reliability` operational surface: liveness / readiness probes, overall + per-
 * component health, the full diagnostics overview, metrics (JSON + Prometheus), per-operation inspection,
 * runtime status, and the frozen architecture manifest. This is what an admin / status / observability
 * dashboard renders to show the health of the whole Communication Fabric (orchestration + adaptive routing
 * + optimization) and the reliability machinery around it (circuit breakers, bulkheads, recovery).
 *
 * @security This lib exchanges operational CONTROL-PLANE metadata ONLY — statuses, metric numbers,
 * operation ids, circuit/queue states — never message content or keys.
 *
 * @example
 * ```js
 * import { FabricReliabilityClient } from "../lib/fabricReliability.js";
 * const ops = new FabricReliabilityClient({ axios });
 * const ready = await ops.ready();       // { ready, status, components }
 * const health = await ops.health();     // per-component health rollup
 * const diag = await ops.diagnostics();  // circuits + bulkheads + recovery + alerts + metrics
 * ```
 */

const BASE = "/api/fabric-reliability";

/** Health status constants (mirror the server `HealthStatus`). */
export const HEALTH = Object.freeze({ HEALTHY: "healthy", DEGRADED: "degraded", UNHEALTHY: "unhealthy", UNKNOWN: "unknown" });

export class FabricReliabilityClient {
  /** @param {object} deps @param {import("axios").AxiosInstance} deps.axios auth-bearing axios instance */
  constructor(deps) {
    if (!deps?.axios) throw new Error("FabricReliabilityClient requires { axios }");
    this.axios = deps.axios;
  }

  /** Liveness — is the process up? */
  async live() {
    const { data } = await this.axios.get(`${BASE}/live`);
    return data.liveness;
  }

  /** Readiness — can the platform accept traffic? */
  async ready() {
    const { data } = await this.axios.get(`${BASE}/ready`);
    return data.readiness;
  }

  /** Overall + per-component health. */
  async health() {
    const { data } = await this.axios.get(`${BASE}/health`);
    return data.health;
  }

  /** Full diagnostics overview (health + metrics + circuits + bulkheads + recovery + alerts). */
  async diagnostics() {
    const { data } = await this.axios.get(`${BASE}/diagnostics`);
    return data.diagnostics;
  }

  /** Metrics snapshot (JSON). */
  async metrics() {
    const { data } = await this.axios.get(`${BASE}/metrics`);
    return data.metrics;
  }

  /** Metrics in Prometheus exposition format (text). */
  async prometheus() {
    const { data } = await this.axios.get(`${BASE}/metrics`, { params: { format: "prometheus" } });
    return data;
  }

  /** Inspect a single operation (checkpoint + audit trail). */
  async inspectOperation(operationId) {
    const { data } = await this.axios.get(`${BASE}/operations/${encodeURIComponent(operationId)}`);
    return data.operation;
  }

  /** Runtime status / statistics. */
  async status() {
    const { data } = await this.axios.get(`${BASE}/status`);
    return data.status;
  }

  /** The frozen architecture manifest (stable APIs + extension points). */
  async freeze() {
    const { data } = await this.axios.get(`${BASE}/freeze`);
    return data.freeze;
  }
}

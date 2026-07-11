/**
 * @module network-reliability/api
 *
 * The **transport-independent Network Reliability API facade**. A small, stable surface over the
 * {@link module:network-reliability/manager NetworkReliabilityManager} — register/heartbeat/recover/
 * reconnect/close a connection, read its health + diagnostics, and READ-ONLY observability (health,
 * metrics, alerts, the frozen protocol manifest, security audit). The Express controller binds here.
 *
 * @security Every mutating op takes an explicit `actingDevice` (owner scoping). Everything returned
 * is CONTROL-PLANE metadata only — never key material. Observability is read-only.
 *
 * @example
 * ```js
 * const api = createReliabilityApi(manager, { monitor, metrics, repository });
 * const conn = await api.register({ actingDevice: "d1", deviceId: "d1", peerId: "d2", sessionId: "s1" });
 * await api.recover({ actingDevice: "d1", connectionId: conn.connectionId, trigger: "unexpected-disconnect" });
 * ```
 */

import { ReliabilityValidationError } from "../errors.js";
import { protocolManifest } from "../freeze/protocolFreeze.js";
import { auditConnectivityApis, normalizePagination } from "../security/securityAudit.js";
import { HealthStatus } from "../types/types.js";

/**
 * @param {import("../manager/networkReliabilityManager.js").NetworkReliabilityManager} manager
 * @param {object} [deps] @param {object} [deps.monitor] @param {object} [deps.metrics] @param {object} [deps.repository] alert store `{ list }`
 * @returns {object} the Reliability API facade
 */
export function createReliabilityApi(manager, deps = {}) {
  if (!manager) throw new Error("createReliabilityApi requires a NetworkReliabilityManager");
  const monitor = deps.monitor ?? manager.monitor ?? null;
  const metrics = deps.metrics ?? manager.metrics;
  const alertRepo = deps.repository ?? null;

  const requireDevice = (actingDevice) => {
    if (!actingDevice) throw new ReliabilityValidationError("actingDevice is required");
    return String(actingDevice);
  };

  return {
    // --- connection lifecycle ------------------------------------------------
    async register(input) {
      const actingDevice = requireDevice(input.actingDevice);
      return manager.registerConnection({ ...input, deviceId: input.deviceId ?? actingDevice });
    },
    async heartbeat(input) {
      const actingDevice = requireDevice(input.actingDevice);
      return manager.recordHeartbeat(input.connectionId, { actingDevice, latencyMs: input.latencyMs });
    },
    async recover(input) {
      const actingDevice = requireDevice(input.actingDevice);
      return manager.recover(input.connectionId, input.trigger, { actingDevice, retryPolicy: input.retryPolicy });
    },
    async reconnect(input) {
      const actingDevice = requireDevice(input.actingDevice);
      return manager.reconnect(input.connectionId, { actingDevice, retryPolicy: input.retryPolicy });
    },
    async reportNetworkEvent(input) {
      const actingDevice = requireDevice(input.actingDevice);
      return manager.reportNetworkEvent(input.connectionId, input.trigger, { actingDevice });
    },
    async close(input) {
      const actingDevice = requireDevice(input.actingDevice);
      return manager.closeConnection(input.connectionId, { actingDevice });
    },

    // --- reads ---------------------------------------------------------------
    async getConnection(input) {
      const actingDevice = requireDevice(input.actingDevice);
      return manager.getConnection(input.connectionId, { actingDevice });
    },
    async getHealth(input) {
      requireDevice(input.actingDevice);
      return manager.getHealth(input.connectionId);
    },
    async getDiagnostics(input) {
      requireDevice(input.actingDevice);
      return manager.getDiagnostics(input.connectionId, { limit: input.limit });
    },
    async listConnections(input) {
      const actingDevice = requireDevice(input.actingDevice);
      const { limit } = normalizePagination(input);
      return manager.listConnections(input.deviceId ?? actingDevice, { limit });
    },
    async recoveryHistory(input) {
      requireDevice(input.actingDevice);
      return manager.getRecoveryHistory(input.connectionId, { limit: input.limit });
    },

    // --- observability (read-only) ------------------------------------------
    async health() {
      const report = monitor ? monitor.report() : { health: HealthStatus.HEALTHY, counts: {}, alerts: [] };
      return {
        status: report.health,
        metrics: { connectionSuccessRate: metrics.connectionSuccessRate?.() ?? 1, recoverySuccessRate: metrics.recoverySuccessRate?.() ?? 1, snapshot: metrics.snapshot() },
        monitor: { health: report.health, counts: report.counts, recentAlerts: report.alerts.length },
        connections: await manager.countByState(),
        freeze: { frozen: protocolManifest.frozen, connectivityVersion: protocolManifest.versions.connectivity },
        security: auditConnectivityApis(),
      };
    },
    async metrics() {
      return metrics.snapshot();
    },
    async prometheus() {
      return metrics.prometheus();
    },
    async alerts(query = {}) {
      const { limit, offset } = normalizePagination(query);
      const list = alertRepo?.list ? await alertRepo.list({ alertType: query.alertType, limit, offset }) : monitor?.alerts(limit) ?? [];
      return { alerts: list, page: { limit, offset } };
    },
    async protocol() {
      return protocolManifest;
    },

    /** The underlying manager (escape hatch). */
    manager,
  };
}

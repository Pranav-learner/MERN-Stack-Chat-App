/**
 * @module transport-reliability/api
 *
 * The stable **reliability service facade** the HTTP controller delegates to. Wraps the
 * {@link TransportReliabilityManager} with the observability + hardening surface: register /
 * checkpoint / recover / resume / migrate / complete / abandon, plus read-only health, metrics
 * (JSON + Prometheus), alerts, diagnostics, the protocol-freeze manifest, and the security audit.
 *
 * @security Read endpoints return CONTROL-PLANE metadata + numeric aggregates only. Every mutating
 * op is owner-scoped in the manager.
 */

import { protocolManifest, isDataPlaneCompatible, EXTENSION_POINTS } from "../freeze/protocolFreeze.js";
import { auditDataPlaneApis, SECURITY_ASSUMPTIONS, normalizePagination } from "../security/securityAudit.js";

/**
 * @param {import("../manager/transportReliabilityManager.js").TransportReliabilityManager} manager
 * @param {{ metrics?: object, monitor?: object, alerts?: object }} [deps]
 */
export function createReliabilityApi(manager, deps = {}) {
  const metrics = deps.metrics ?? manager.metrics ?? null;
  const monitor = deps.monitor ?? manager.monitor ?? null;
  const alertsStore = deps.alerts ?? null;

  return {
    // --- transfer lifecycle ---
    register: (params) => manager.registerTransfer(params),
    checkpoint: (params) => manager.checkpoint(params),
    complete: ({ transferId, actingDevice }) => manager.complete(transferId, { actingDevice }),
    reportInterruption: ({ transferId, trigger, actingDevice, autoRecover }) => manager.reportInterruption(transferId, trigger, { actingDevice, autoRecover }),
    recover: ({ transferId, trigger, actingDevice, newConnectionId }) => manager.recover(transferId, trigger, { actingDevice, newConnectionId }),
    resume: ({ transferId, actingDevice }) => manager.resume(transferId, { actingDevice }),
    migrate: ({ transferId, newConnectionId, trigger, actingDevice }) => manager.migrate(transferId, newConnectionId, { trigger, actingDevice }),
    abandon: ({ transferId, actingDevice, reason }) => manager.abandon(transferId, { actingDevice, reason }),

    // --- reads ---
    getRecord: ({ transferId, actingDevice }) => manager.getRecord(transferId, { actingDevice }),
    getHealth: ({ transferId }) => manager.getHealth(transferId),
    getDiagnostics: ({ transferId, actingDevice }) => manager.getDiagnostics(transferId, { actingDevice }),
    listTransfers: ({ deviceId, state, limit }) => manager.listTransfers({ deviceId, state, limit }),

    // --- observability (read-only) ---
    health: () => manager.health(),
    metrics: () => (metrics ? metrics.snapshot() : { counters: {}, gauges: {}, histograms: {} }),
    prometheus: () => (metrics ? metrics.prometheus() : ""),
    alerts: async (query = {}) => {
      const { limit, offset } = normalizePagination(query);
      if (alertsStore?.list) return alertsStore.list({ limit, offset });
      return { total: 0, alerts: monitor ? monitor.recentAlerts(limit) : [] };
    },

    // --- freeze + security ---
    protocol: () => ({ ...protocolManifest, compatible: isDataPlaneCompatible(protocolManifest.versions.dataPlane), extensionPoints: EXTENSION_POINTS }),
    securityAudit: () => ({ ...auditDataPlaneApis(), assumptions: SECURITY_ASSUMPTIONS }),
  };
}

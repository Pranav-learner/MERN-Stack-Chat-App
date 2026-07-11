/**
 * @module synchronization-reliability/api
 *
 * The stable **reliability service facade** the HTTP controller delegates to. Wraps the
 * {@link SyncReliabilityManager} with the observability + hardening surface: register / checkpoint /
 * recover / resume / complete / abandon, plus read-only health, metrics (JSON + Prometheus), alerts,
 * diagnostics, the protocol-freeze manifest, and the security audit.
 *
 * @security Read endpoints return CONTROL-PLANE metadata + numeric aggregates only. Every mutating op
 * is owner-scoped in the manager.
 */

import { protocolManifest, isSyncLayerCompatible, EXTENSION_POINTS } from "../freeze/protocolFreeze.js";
import { auditSyncApis, SECURITY_ASSUMPTIONS, normalizePagination } from "../security/securityAudit.js";

export function createReliabilityApi(manager, deps = {}) {
  const metrics = deps.metrics ?? manager.metrics ?? null;
  const monitor = deps.monitor ?? manager.monitor ?? null;
  const alertsStore = deps.alerts ?? null;

  return {
    // sync lifecycle
    register: (params) => manager.registerSync(params),
    checkpoint: (params) => manager.checkpoint(params),
    complete: ({ syncId, actingDevice }) => manager.complete(syncId, { actingDevice }),
    reportInterruption: ({ syncId, trigger, actingDevice, autoRecover }) => manager.reportInterruption(syncId, trigger, { actingDevice, autoRecover }),
    recover: ({ syncId, trigger, actingDevice }) => manager.recover(syncId, trigger, { actingDevice }),
    resume: ({ syncId, actingDevice }) => manager.resume(syncId, { actingDevice }),
    abandon: ({ syncId, actingDevice, reason }) => manager.abandon(syncId, { actingDevice, reason }),

    // reads
    getRecord: ({ syncId, actingDevice }) => manager.getRecord(syncId, { actingDevice }),
    getHealth: ({ syncId }) => manager.getHealth(syncId),
    getDiagnostics: ({ syncId, actingDevice }) => manager.getDiagnostics(syncId, { actingDevice }),
    listSyncs: ({ userId, state, limit }) => manager.listSyncs({ userId, state, limit }),

    // observability (read-only)
    health: () => manager.health(),
    metrics: () => (metrics ? metrics.snapshot() : { counters: {}, gauges: {}, histograms: {} }),
    prometheus: () => (metrics ? metrics.prometheus() : ""),
    alerts: async (query = {}) => {
      const { limit, offset } = normalizePagination(query);
      if (alertsStore?.list) return alertsStore.list({ limit, offset });
      return { total: 0, alerts: monitor ? monitor.recentAlerts(limit) : [] };
    },

    // freeze + security
    protocol: () => ({ ...protocolManifest, compatible: isSyncLayerCompatible(protocolManifest.versions.syncLayer), extensionPoints: EXTENSION_POINTS }),
    securityAudit: () => ({ ...auditSyncApis(), assumptions: SECURITY_ASSUMPTIONS }),
  };
}

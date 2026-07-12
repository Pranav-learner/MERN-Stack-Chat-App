/**
 * @module media-reliability/api
 *
 * The stable **media-reliability service facade** the HTTP controller delegates to. Wraps the
 * {@link MediaReliabilityManager} with the observability + hardening surface: register / checkpoint /
 * recover / resume / complete / abandon, plus read-only health (per-operation + per-media), metrics
 * (JSON + Prometheus), alerts, diagnostics, the audit trail, the protocol-freeze manifest, and the
 * security audit.
 *
 * @security Read endpoints return CONTROL-PLANE metadata + numeric aggregates only. Every mutating op is
 * owner-scoped + audited in the manager.
 */

import { protocolManifest, isMediaLayerCompatible, EXTENSION_POINTS } from "../freeze/protocolFreeze.js";
import { auditMediaApis, SECURITY_ASSUMPTIONS, normalizePagination } from "../security/securityAudit.js";

export function createMediaReliabilityApi(manager, deps = {}) {
  const metrics = deps.metrics ?? manager.metrics ?? null;
  const monitor = deps.monitor ?? manager.monitor ?? null;
  const alertsStore = deps.alerts ?? null;
  const auditStore = deps.audit ?? manager.audit ?? null;

  return {
    // operation lifecycle
    register: (params) => manager.registerOperation(params),
    checkpoint: (params) => manager.checkpoint(params),
    complete: ({ operationId, actingDevice }) => manager.complete(operationId, { actingDevice }),
    reportInterruption: ({ operationId, trigger, actingDevice, autoRecover }) => manager.reportInterruption(operationId, trigger, { actingDevice, autoRecover }),
    recover: ({ operationId, trigger, actingDevice }) => manager.recover(operationId, trigger, { actingDevice }),
    resume: ({ operationId, actingDevice }) => manager.resume(operationId, { actingDevice }),
    abandon: ({ operationId, actingDevice, reason }) => manager.abandon(operationId, { actingDevice, reason }),

    // reads
    getRecord: ({ operationId, actingDevice }) => manager.getRecord(operationId, { actingDevice }),
    getHealth: ({ operationId }) => manager.getHealth(operationId),
    getMediaHealth: ({ mediaId }) => manager.getMediaHealth(mediaId),
    getDiagnostics: ({ operationId, actingDevice }) => manager.getDiagnostics(operationId, { actingDevice }),
    listOperations: ({ mediaId, userId, state, limit }) => manager.listOperations({ mediaId, userId, state, limit }),

    // observability (read-only)
    health: () => manager.health(),
    metrics: () => (metrics ? metrics.snapshot() : { counters: {}, gauges: {}, histograms: {} }),
    prometheus: () => (metrics ? metrics.prometheus() : ""),
    alerts: async (query = {}) => {
      const { limit, offset } = normalizePagination(query);
      if (alertsStore?.list) return alertsStore.list({ limit, offset });
      return { total: 0, alerts: monitor ? monitor.recentAlerts(limit) : [] };
    },
    auditTrail: async ({ mediaId, limit } = {}) => {
      if (!auditStore) return [];
      return mediaId ? auditStore.listByMedia(mediaId, { limit }) : auditStore.list({ limit });
    },

    // freeze + security
    protocol: () => ({ ...protocolManifest, compatible: isMediaLayerCompatible(protocolManifest.versions.mediaLayer), extensionPoints: EXTENSION_POINTS }),
    securityAudit: () => ({ ...auditMediaApis(), assumptions: SECURITY_ASSUMPTIONS }),
  };
}

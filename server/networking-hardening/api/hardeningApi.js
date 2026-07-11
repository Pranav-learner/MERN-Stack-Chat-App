/**
 * @module networking-hardening/api
 *
 * The **transport-independent Networking Hardening API facade**. A small, stable, READ-ONLY surface
 * over the {@link module:networking-hardening/manager NetworkingHardeningManager} — health, metrics
 * (JSON + Prometheus), alerts, the frozen protocol manifest, and the API security audit. The Express
 * controller binds to this.
 *
 * @security Read-only observability. Everything returned is METADATA + numeric aggregates — never key
 * material. Alert listing is paginated + bounded (API hardening).
 */

import { normalizePagination } from "../security/securityAudit.js";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "../types/types.js";

/**
 * @param {import("../manager/networkingHardeningManager.js").NetworkingHardeningManager} manager
 * @param {object} [deps] @param {object} [deps.repository] alert store `{ list, count }`
 * @returns {object} the hardening API facade
 */
export function createHardeningApi(manager, deps = {}) {
  if (!manager) throw new Error("createHardeningApi requires a NetworkingHardeningManager");
  const repository = deps.repository ?? null;

  return {
    /** The consolidated control-plane health snapshot. */
    async health() {
      return manager.health();
    },

    /** Metrics as a structured JSON snapshot. */
    async metrics() {
      return manager.metrics.snapshot();
    },

    /** Metrics in Prometheus text-exposition format. */
    async prometheus() {
      return manager.prometheus();
    },

    /**
     * Recent alerts. Prefers the persisted store (paginated) and falls back to the in-process ring.
     * @param {{ alertType?: string, severity?: string, limit?: number|string, offset?: number|string }} [query]
     * @returns {Promise<{ alerts: object[], page: { limit: number, offset: number } }>}
     */
    async alerts(query = {}) {
      const { limit, offset } = normalizePagination(query, { maxLimit: MAX_PAGE_SIZE, defaultLimit: DEFAULT_PAGE_SIZE });
      let alerts;
      if (repository?.list) alerts = await repository.list({ alertType: query.alertType, severity: query.severity, limit, offset });
      else alerts = manager.monitor.alerts(limit);
      return { alerts, page: { limit, offset } };
    },

    /** The frozen protocol manifest (stable interfaces + Layer-7 extension points). */
    async protocol() {
      return manager.manifest();
    },

    /** The result of auditing every networking API's security posture. */
    async securityAudit() {
      return manager.health().security;
    },

    /** The underlying manager (escape hatch). */
    manager,
  };
}

/**
 * @module networking-hardening/repository/inMemory
 *
 * In-memory hardening repository: the reference for the alert-store contract and the test backend.
 * Persists networking alerts the monitor raises. Deep-copies in + out; imports no driver, so it runs
 * under `node --test`.
 *
 * ## Alert store contract (shared with Mongo)
 * - `record(alert) -> alert`
 * - `list({ alertType, severity, limit, offset }) -> alert[]`  (newest first)
 * - `count({ alertType }) -> number`
 */

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));

/** @returns {{ alerts: object, reset: () => void }} */
export function createInMemoryHardeningRepository() {
  /** @type {object[]} */
  const alerts = [];

  const store = {
    async record(alert) {
      alerts.push(clone(alert));
      return clone(alert);
    },
    async list(options = {}) {
      let out = alerts;
      if (options.alertType) out = out.filter((a) => a.alertType === options.alertType);
      if (options.severity) out = out.filter((a) => a.severity === options.severity);
      out = [...out].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 50;
      return out.slice(offset, offset + limit).map(clone);
    },
    async count(options = {}) {
      if (options.alertType) return alerts.filter((a) => a.alertType === options.alertType).length;
      return alerts.length;
    },
  };

  return {
    alerts: store,
    reset: () => {
      alerts.length = 0;
    },
  };
}

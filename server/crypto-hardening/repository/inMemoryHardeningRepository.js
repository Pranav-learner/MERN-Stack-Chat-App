/**
 * @module crypto-hardening/repository/inMemory
 *
 * In-memory hardening repository: stores security ALERTS + hardening audit records (metadata
 * only). The reference for the repository contract + the test backend. Records are deep-copied;
 * bounded to avoid unbounded growth. Imports no driver, so it runs under `node --test`.
 *
 * ## Contract (shared with the Mongo implementation)
 * `alerts`:
 * - `record(alert) -> alert`
 * - `list({ limit? }) -> alert[]`  (newest first)
 * - `listBySession(sessionId, { limit? }) -> alert[]`
 * - `count() -> number`
 */

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));

/** @param {{ max?: number }} [options] @returns {{ alerts: object, reset: () => void }} */
export function createInMemoryHardeningRepository(options = {}) {
  const max = options.max ?? 5000;
  /** @type {object[]} */
  let log = [];

  const alerts = {
    async record(alert) {
      log.push(clone(alert));
      if (log.length > max) log = log.slice(log.length - max);
      return clone(alert);
    },
    async list({ limit = 100 } = {}) {
      return log.slice(-limit).reverse().map(clone);
    },
    async listBySession(sessionId, { limit = 100 } = {}) {
      return log
        .filter((a) => String(a.sessionId) === String(sessionId))
        .slice(-limit)
        .reverse()
        .map(clone);
    },
    async count() {
      return log.length;
    },
  };

  return { alerts, reset: () => (log = []) };
}

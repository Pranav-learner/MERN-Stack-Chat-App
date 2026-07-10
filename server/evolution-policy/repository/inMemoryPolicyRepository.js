/**
 * @module evolution-policy/repository/inMemory
 *
 * In-memory automatic-rekey repository: the reference for the repository contract and the
 * test/device backend. Stores per-session policy configuration + execution history +
 * rekey history + pending operations + audit — METADATA only (no keys; the crypto lives in
 * the Sprint 2 engine). Records are deep-copied. Imports no driver, so it runs under
 * `node --test`.
 *
 * ## Contract (shared with the Mongo implementation)
 * `rekeyPolicies`:
 * - `create(state) -> state`
 * - `findBySessionId(sessionId) -> state | null`
 * - `update(sessionId, patch) -> state`
 * - `delete(sessionId) -> boolean`
 * - `findEnabled() -> state[]`  (sessions with automatic rekeying enabled)
 * - `listAll() -> state[]`
 */

import { RekeyNotConfiguredError } from "../errors.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));

/** @returns {{ rekeyPolicies: object, reset: () => void }} */
export function createInMemoryPolicyRepository() {
  /** @type {Map<string, object>} sessionId -> policy state */
  const bySession = new Map();

  const rekeyPolicies = {
    async create(state) {
      bySession.set(state.sessionId, clone(state));
      return clone(state);
    },
    async findBySessionId(sessionId) {
      const key = String(sessionId);
      return bySession.has(key) ? clone(bySession.get(key)) : null;
    },
    async update(sessionId, patch) {
      const key = String(sessionId);
      const existing = bySession.get(key);
      if (!existing) throw new RekeyNotConfiguredError("Automatic rekeying is not configured for this session", { details: { sessionId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      bySession.set(key, clone(updated));
      return clone(updated);
    },
    async delete(sessionId) {
      return bySession.delete(String(sessionId));
    },
    async findEnabled() {
      return [...bySession.values()].filter((s) => s.config?.enabled !== false).map(clone);
    },
    async listAll() {
      return [...bySession.values()].map(clone);
    },
  };

  return { rekeyPolicies, reset: () => bySession.clear() };
}

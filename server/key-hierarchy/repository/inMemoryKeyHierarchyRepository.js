/**
 * @module key-hierarchy/repository/inMemory
 *
 * In-memory key-hierarchy repository: the reference for the repository contract and the
 * test/device backend. Stores per-session hierarchy METADATA — root-key + chain metadata,
 * chain history, versions, archived chains, and audit — NEVER key material (that lives in
 * the device key store). Records are deep-copied. Imports no driver, so it runs under
 * `node --test`.
 *
 * ## Contract (shared with the Mongo implementation)
 * `hierarchies`:
 * - `create(state) -> state`
 * - `findBySessionId(sessionId) -> state | null`
 * - `update(sessionId, patch) -> state`
 * - `delete(sessionId) -> boolean`
 * - `findByGeneration(min) -> state[]`
 * - `listAll() -> state[]`
 */

import { HierarchyNotFoundError } from "../errors.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));

/** @returns {{ hierarchies: object, reset: () => void }} */
export function createInMemoryKeyHierarchyRepository() {
  /** @type {Map<string, object>} sessionId -> hierarchy state */
  const bySession = new Map();

  const hierarchies = {
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
      if (!existing) throw new HierarchyNotFoundError("Key hierarchy not found", { details: { sessionId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      bySession.set(key, clone(updated));
      return clone(updated);
    },
    async delete(sessionId) {
      return bySession.delete(String(sessionId));
    },
    async findByGeneration(min) {
      return [...bySession.values()].filter((s) => (s.generation ?? 0) >= min).map(clone);
    },
    async listAll() {
      return [...bySession.values()].map(clone);
    },
  };

  return { hierarchies, reset: () => bySession.clear() };
}

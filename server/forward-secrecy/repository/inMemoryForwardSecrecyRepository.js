/**
 * @module forward-secrecy/repository/inMemory
 *
 * In-memory Forward Secrecy metadata repository: the reference for the repository
 * contract and the test/device backend. Stores per-session FS METADATA — current
 * generation, generation history (keyId/fingerprint/status/timestamps), destruction
 * records, and audit — NEVER key material (that lives in the device key store). Records
 * are deep-copied. Imports no driver, so the whole stack runs under `node --test`.
 *
 * ## Contract (shared with the Mongo implementation)
 * `forwardSecrecy`:
 * - `create(state) -> state`
 * - `findBySessionId(sessionId) -> state | null`
 * - `update(sessionId, patch) -> state`
 * - `delete(sessionId) -> boolean`
 * - `findByGeneration(min) -> state[]`  (sessions at/above a generation)
 * - `listAll() -> state[]`
 */

import { GenerationNotFoundError } from "../errors.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));

/** @returns {{ forwardSecrecy: object, reset: () => void }} */
export function createInMemoryForwardSecrecyRepository() {
  /** @type {Map<string, object>} sessionId -> FS state */
  const bySession = new Map();

  const forwardSecrecy = {
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
      if (!existing) throw new GenerationNotFoundError("Forward secrecy state not found", { details: { sessionId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      bySession.set(key, clone(updated));
      return clone(updated);
    },
    async delete(sessionId) {
      return bySession.delete(String(sessionId));
    },
    async findByGeneration(min) {
      return [...bySession.values()].filter((s) => (s.currentGeneration ?? 0) >= min).map(clone);
    },
    async listAll() {
      return [...bySession.values()].map(clone);
    },
  };

  return { forwardSecrecy, reset: () => bySession.clear() };
}

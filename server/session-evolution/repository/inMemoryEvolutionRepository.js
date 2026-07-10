/**
 * @module session-evolution/repository/inMemory
 *
 * In-memory Evolution repository: the reference for the repository contract and the
 * test/device backend. Stores evolution METADATA records (never key material — the
 * framework performs no cryptography). Records are deep-copied. Imports no driver, so
 * the whole stack runs under `node --test`.
 *
 * ## Contract (shared with the Mongo implementation)
 * `evolutions`:
 * - `create(record) -> record`
 * - `findBySessionId(sessionId) -> record | null`  (primary lookup — one per session)
 * - `findById(evolutionId) -> record | null`
 * - `update(sessionId, patch) -> record`
 * - `delete(sessionId) -> boolean`
 * - `findByState(state) -> record[]`
 * - `listAll() -> record[]`
 */

import { EvolutionNotFoundError } from "../errors.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));

/** @returns {{ evolutions: object, reset: () => void }} */
export function createInMemoryEvolutionRepository() {
  /** @type {Map<string, object>} sessionId -> record */
  const bySession = new Map();

  const evolutions = {
    async create(record) {
      bySession.set(record.sessionId, clone(record));
      return clone(record);
    },
    async findBySessionId(sessionId) {
      const key = String(sessionId);
      return bySession.has(key) ? clone(bySession.get(key)) : null;
    },
    async findById(evolutionId) {
      const match = [...bySession.values()].find((r) => r.evolutionId === evolutionId);
      return match ? clone(match) : null;
    },
    async update(sessionId, patch) {
      const key = String(sessionId);
      const existing = bySession.get(key);
      if (!existing) throw new EvolutionNotFoundError("Evolution state not found", { details: { sessionId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      bySession.set(key, clone(updated));
      return clone(updated);
    },
    async delete(sessionId) {
      return bySession.delete(String(sessionId));
    },
    async findByState(state) {
      return [...bySession.values()].filter((r) => r.state === state).map(clone);
    },
    async listAll() {
      return [...bySession.values()].map(clone);
    },
  };

  return { evolutions, reset: () => bySession.clear() };
}

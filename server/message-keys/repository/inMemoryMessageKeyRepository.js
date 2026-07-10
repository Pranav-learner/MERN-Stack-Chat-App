/**
 * @module message-keys/repository/inMemory
 *
 * In-memory message-key repository: the reference for the repository contract and the
 * test/device backend. Stores per-session message METADATA — counters, generation, a capped
 * message log (numbers / key ids / fingerprints / delivery), and audit.
 *
 * @security **NEVER persists a raw message key.** Message keys are ephemeral, device-local,
 * and wiped after use; only their PUBLIC metadata is recorded. Records are deep-copied.
 *
 * ## Contract (shared with the Mongo implementation)
 * `messageKeys`:
 * - `create(state) -> state`
 * - `findBySessionId(sessionId) -> state | null`
 * - `update(sessionId, patch) -> state`
 * - `delete(sessionId) -> boolean`
 * - `listAll() -> state[]`
 */

import { MessageKeyNotFoundError } from "../errors.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));

/** @returns {{ messageKeys: object, reset: () => void }} */
export function createInMemoryMessageKeyRepository() {
  /** @type {Map<string, object>} sessionId -> message-key state */
  const bySession = new Map();

  const messageKeys = {
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
      if (!existing) throw new MessageKeyNotFoundError("Message key state not found", { details: { sessionId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      bySession.set(key, clone(updated));
      return clone(updated);
    },
    async delete(sessionId) {
      return bySession.delete(String(sessionId));
    },
    async listAll() {
      return [...bySession.values()].map(clone);
    },
  };

  return { messageKeys, reset: () => bySession.clear() };
}

/**
 * @module shs/session/repository/inMemory
 *
 * In-memory Secure Session repository: the reference for the repository contract and
 * the test/device backend. Stores session METADATA records (never raw keys — those
 * live in the {@link module:shs/session/storage} secure key store). Records are
 * deep-copied. Imports no driver, so the whole stack runs under `node --test`.
 *
 * ## Contract (shared with the Mongo implementation)
 * `sessions`:
 * - `create(session) -> session`
 * - `findById(sessionId) -> session | null`
 * - `update(sessionId, patch) -> session`
 * - `delete(sessionId) -> boolean`
 * - `findActiveByHandshake(handshakeId) -> session | null`  (active-family only)
 * - `listByUser(userId) -> session[]`  (participant)
 * - `findByState(state) -> session[]`
 * - `listAll() -> session[]`
 */

import { SessionNotFoundError } from "../errors.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));
const ACTIVE = new Set(["created", "active", "idle", "paused", "resumed"]);

/** @returns {{ sessions: object, reset: () => void }} */
export function createInMemorySessionRepository() {
  /** @type {Map<string, object>} sessionId -> session */
  const byId = new Map();

  const sessions = {
    async create(session) {
      byId.set(session.sessionId, clone(session));
      return clone(session);
    },
    async findById(sessionId) {
      return byId.has(sessionId) ? clone(byId.get(sessionId)) : null;
    },
    async update(sessionId, patch) {
      const existing = byId.get(sessionId);
      if (!existing) throw new SessionNotFoundError("Session not found", { details: { sessionId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      byId.set(sessionId, clone(updated));
      return clone(updated);
    },
    async delete(sessionId) {
      return byId.delete(sessionId);
    },
    async findActiveByHandshake(handshakeId) {
      const match = [...byId.values()].find((s) => String(s.handshakeId) === String(handshakeId) && ACTIVE.has(s.status));
      return match ? clone(match) : null;
    },
    async listByUser(userId) {
      const id = String(userId);
      return [...byId.values()].filter((s) => (s.participants ?? []).map(String).includes(id)).map(clone);
    },
    async findByState(state) {
      return [...byId.values()].filter((s) => s.status === state).map(clone);
    },
    async listAll() {
      return [...byId.values()].map(clone);
    },
  };

  return { sessions, reset: () => byId.clear() };
}

/**
 * @module shs/repository/inMemory
 *
 * In-memory handshake-session repository for tests and as the reference for the
 * repository contract. Records are deep-copied on the way in and out so callers
 * cannot mutate stored state by reference. Imports NO storage driver, so it (and
 * everything above it) runs under `node --test` with zero dependencies.
 *
 * ## Contract (shared with the Mongo implementation)
 * `sessions`:
 * - `create(session) -> session`
 * - `findById(handshakeId) -> session | null`
 * - `update(handshakeId, patch) -> session`
 * - `delete(handshakeId) -> boolean`
 * - `findActiveByPair(initiator, responder) -> session | null`  (non-terminal)
 * - `listByUser(userId) -> session[]`  (initiator OR responder)
 * - `findByState(state) -> session[]`
 * - `listAll() -> session[]`
 */

import { TERMINAL_HANDSHAKE_STATES } from "../types.js";
import { HandshakeNotFoundError } from "../errors.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));
const TERMINAL = new Set(TERMINAL_HANDSHAKE_STATES);

/** @returns {{ sessions: object, reset: () => void }} */
export function createInMemoryShsRepository() {
  /** @type {Map<string, object>} handshakeId -> session */
  const byId = new Map();

  const sessions = {
    async create(session) {
      byId.set(session.handshakeId, clone(session));
      return clone(session);
    },
    async findById(handshakeId) {
      return byId.has(handshakeId) ? clone(byId.get(handshakeId)) : null;
    },
    async update(handshakeId, patch) {
      const existing = byId.get(handshakeId);
      if (!existing) {
        throw new HandshakeNotFoundError("Handshake not found", { details: { handshakeId } });
      }
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      byId.set(handshakeId, clone(updated));
      return clone(updated);
    },
    async delete(handshakeId) {
      return byId.delete(handshakeId);
    },
    async findActiveByPair(initiator, responder) {
      const a = String(initiator);
      const b = String(responder);
      const match = [...byId.values()].find(
        (s) => String(s.initiator) === a && String(s.responder) === b && !TERMINAL.has(s.state),
      );
      return match ? clone(match) : null;
    },
    async listByUser(userId) {
      const id = String(userId);
      return [...byId.values()]
        .filter((s) => String(s.initiator) === id || String(s.responder) === id)
        .map(clone);
    },
    async findByState(state) {
      return [...byId.values()].filter((s) => s.state === state).map(clone);
    },
    async listAll() {
      return [...byId.values()].map(clone);
    },
  };

  return {
    sessions,
    reset: () => byId.clear(),
  };
}

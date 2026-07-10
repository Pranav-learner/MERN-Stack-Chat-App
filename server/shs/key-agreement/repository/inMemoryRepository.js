/**
 * @module shs/key-agreement/repository/inMemory
 *
 * In-memory key-agreement repositories: the PUBLIC `exchanges` store (coordination
 * records the server relays) and the DEVICE-LOCAL `material` store (session material
 * INCLUDING the shared secret). Records are deep-copied. Imports no driver, so the
 * whole stack runs under `node --test` with zero deps.
 *
 * @security The `material` store models a DEVICE's secure local storage — it is the
 * ONLY place a shared secret lives, and only in tests / on the client. The server's
 * production wiring uses the Mongo repository, which persists `exchanges` ONLY.
 *
 * ## Contract
 * `exchanges` (PUBLIC): create · findById · update · delete · findActive · listByUser · findByState · listAll
 * `material` (SECRET, local): create · findByHandshake · findById · delete · deleteByHandshake · list · history
 */

import { ExchangeNotFoundError, SessionMaterialNotFoundError } from "../errors.js";
import { TERMINAL_EXCHANGE_STATES } from "./constants.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));

/** @returns {{ exchanges: object, material: object, reset: () => void }} */
export function createInMemoryKeyAgreementRepositories() {
  /** @type {Map<string, object>} handshakeId -> exchange */
  const exchangesById = new Map();
  /** @type {Map<string, object>} handshakeId -> material */
  const materialByHandshake = new Map();
  /** @type {Map<string, object>} sessionId -> material */
  const materialById = new Map();
  /** @type {object[]} append-only session-material history (metadata only) */
  const materialHistory = [];

  const exchanges = {
    async create(record) {
      exchangesById.set(record.handshakeId, clone(record));
      return clone(record);
    },
    async findById(handshakeId) {
      return exchangesById.has(handshakeId) ? clone(exchangesById.get(handshakeId)) : null;
    },
    async update(handshakeId, patch) {
      const existing = exchangesById.get(handshakeId);
      if (!existing) throw new ExchangeNotFoundError("Exchange not found", { details: { handshakeId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      exchangesById.set(handshakeId, clone(updated));
      return clone(updated);
    },
    async delete(handshakeId) {
      return exchangesById.delete(handshakeId);
    },
    async findActive(handshakeId) {
      const rec = exchangesById.get(handshakeId);
      return rec && !TERMINAL_EXCHANGE_STATES.has(rec.state) ? clone(rec) : null;
    },
    async listByUser(userId) {
      const id = String(userId);
      return [...exchangesById.values()]
        .filter((r) => String(r.initiator) === id || String(r.responder) === id)
        .map(clone);
    },
    async findByState(state) {
      return [...exchangesById.values()].filter((r) => r.state === state).map(clone);
    },
    async listAll() {
      return [...exchangesById.values()].map(clone);
    },
  };

  const material = {
    async create(record) {
      materialByHandshake.set(record.handshakeId, clone(record));
      materialById.set(record.sessionId, clone(record));
      // History stores METADATA ONLY (no secret) — see the serializer.
      materialHistory.push({
        sessionId: record.sessionId,
        handshakeId: record.handshakeId,
        algorithm: record.algorithm,
        fingerprint: record.sharedSecretFingerprint,
        createdAt: record.createdAt,
      });
      return clone(record);
    },
    async findByHandshake(handshakeId) {
      return materialByHandshake.has(handshakeId) ? clone(materialByHandshake.get(handshakeId)) : null;
    },
    async findById(sessionId) {
      return materialById.has(sessionId) ? clone(materialById.get(sessionId)) : null;
    },
    async delete(sessionId) {
      const rec = materialById.get(sessionId);
      if (!rec) return false;
      materialById.delete(sessionId);
      materialByHandshake.delete(rec.handshakeId);
      return true;
    },
    async deleteByHandshake(handshakeId) {
      const rec = materialByHandshake.get(handshakeId);
      if (!rec) return false;
      materialByHandshake.delete(handshakeId);
      materialById.delete(rec.sessionId);
      return true;
    },
    async requireByHandshake(handshakeId) {
      const rec = await this.findByHandshake(handshakeId);
      if (!rec) throw new SessionMaterialNotFoundError("No session material", { details: { handshakeId } });
      return rec;
    },
    async list() {
      return [...materialByHandshake.values()].map(clone);
    },
    async history() {
      return materialHistory.map(clone);
    },
  };

  return {
    exchanges,
    material,
    reset: () => {
      exchangesById.clear();
      materialByHandshake.clear();
      materialById.clear();
      materialHistory.length = 0;
    },
  };
}

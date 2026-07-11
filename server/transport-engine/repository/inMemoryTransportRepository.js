/**
 * @module transport-engine/repository/inMemory
 *
 * In-memory transport repositories: the reference for the store contracts + the test/device backend.
 * Bundles the stores the engine needs:
 *
 * - `transfers` — transfer metadata + delivery state (the source of truth for a transfer).
 * - `chunks`    — per-chunk metadata + the OPAQUE ciphertext fragment.
 * - `progress`  — latest progress snapshot per transfer (fast reads).
 * - `history`   — completed/failed transfer audit trail.
 * - `audit`     — free-form audit events.
 *
 * Records are deep-copied in + out. Imports no driver, so the whole stack runs under `node --test`.
 *
 * ## Contract (shared with Mongo)
 * transfers: `create · findById · update · delete · listActive · listByConversation · listByParticipant · listExpired · countByState`
 * chunks: `upsert · findById · findByTransfer · update · listRetryDue · countByState · deleteByTransfer`
 */

import { TransferNotFoundError, ChunkValidationError } from "../errors.js";
import { ACTIVE_TRANSFER_STATES, ChunkState } from "../types/types.js";

const clone = (v) => (v == null ? v : structuredClone(v));
const ACTIVE = new Set(ACTIVE_TRANSFER_STATES);
const RETRYABLE = new Set([ChunkState.SENT]);

/** @returns {{ transfers, chunks, progress, history, audit, reset }} */
export function createInMemoryTransportRepository() {
  /** @type {Map<string, object>} transferId -> transfer */
  const transfersById = new Map();
  /** @type {Map<string, Map<string, object>>} transferId -> (chunkId -> chunk) */
  const chunksByTransfer = new Map();
  /** @type {Map<string, object>} transferId -> progress */
  const progressById = new Map();
  /** @type {object[]} history */
  const historyLog = [];
  /** @type {object[]} audit */
  const auditLog = [];

  const transfers = {
    async create(t) {
      transfersById.set(t.transferId, clone(t));
      return clone(t);
    },
    async findById(transferId) {
      const t = transfersById.get(String(transferId));
      return t ? clone(t) : null;
    },
    async update(transferId, patch) {
      const key = String(transferId);
      const existing = transfersById.get(key);
      if (!existing) throw new TransferNotFoundError("Transfer not found", { details: { transferId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      transfersById.set(key, clone(updated));
      return clone(updated);
    },
    async delete(transferId) {
      chunksByTransfer.delete(String(transferId));
      progressById.delete(String(transferId));
      return transfersById.delete(String(transferId));
    },
    async listActive(deviceId) {
      const id = deviceId != null ? String(deviceId) : null;
      return [...transfersById.values()]
        .filter((t) => ACTIVE.has(t.state) && (id === null || t.senderDeviceId === id || t.receiverDeviceId === id))
        .map(clone);
    },
    async listByConversation(conversationId, options = {}) {
      const cid = String(conversationId);
      const list = [...transfersById.values()].filter((t) => t.conversationId === cid).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
    async listByParticipant(deviceId, options = {}) {
      const id = String(deviceId);
      let list = [...transfersById.values()].filter((t) => t.senderDeviceId === id || t.receiverDeviceId === id);
      if (options.state) list = list.filter((t) => t.state === options.state);
      list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
    async listExpired(nowIso) {
      const now = new Date(nowIso ?? new Date().toISOString()).getTime();
      return [...transfersById.values()].filter((t) => ACTIVE.has(t.state) && t.expiresAt && new Date(t.expiresAt).getTime() <= now).map(clone);
    },
    async countByState() {
      const counts = {};
      for (const t of transfersById.values()) counts[t.state] = (counts[t.state] ?? 0) + 1;
      return counts;
    },
  };

  const chunks = {
    async upsert(chunk) {
      if (!chunk?.chunkId || !chunk?.transferId) throw new ChunkValidationError("chunk requires { chunkId, transferId }");
      let map = chunksByTransfer.get(chunk.transferId);
      if (!map) {
        map = new Map();
        chunksByTransfer.set(chunk.transferId, map);
      }
      map.set(chunk.chunkId, clone(chunk));
      return clone(chunk);
    },
    async findById(chunkId) {
      for (const map of chunksByTransfer.values()) {
        const c = map.get(String(chunkId));
        if (c) return clone(c);
      }
      return null;
    },
    async findByTransfer(transferId, options = {}) {
      const map = chunksByTransfer.get(String(transferId));
      if (!map) return [];
      let list = [...map.values()];
      if (options.states) {
        const set = new Set(options.states);
        list = list.filter((c) => set.has(c.state));
      }
      list.sort((a, b) => a.index - b.index);
      return list.map(clone);
    },
    async update(chunkId, patch) {
      for (const map of chunksByTransfer.values()) {
        const existing = map.get(String(chunkId));
        if (existing) {
          const updated = { ...existing, ...patch };
          map.set(String(chunkId), clone(updated));
          return clone(updated);
        }
      }
      throw new ChunkValidationError("Chunk not found", { details: { chunkId } });
    },
    async listRetryDue(transferId, nowIso) {
      const map = chunksByTransfer.get(String(transferId));
      if (!map) return [];
      const now = new Date(nowIso ?? new Date().toISOString()).getTime();
      return [...map.values()].filter((c) => RETRYABLE.has(c.state) && c.nextRetryAt && new Date(c.nextRetryAt).getTime() <= now).sort((a, b) => a.index - b.index).map(clone);
    },
    async countByState(transferId) {
      const map = chunksByTransfer.get(String(transferId));
      const counts = {};
      if (map) for (const c of map.values()) counts[c.state] = (counts[c.state] ?? 0) + 1;
      return counts;
    },
    async deleteByTransfer(transferId) {
      const map = chunksByTransfer.get(String(transferId));
      const n = map ? map.size : 0;
      chunksByTransfer.delete(String(transferId));
      return n;
    },
  };

  const progress = {
    async save(transferId, snapshot) {
      progressById.set(String(transferId), clone({ transferId: String(transferId), ...snapshot }));
      return clone(progressById.get(String(transferId)));
    },
    async get(transferId) {
      const p = progressById.get(String(transferId));
      return p ? clone(p) : null;
    },
  };

  const history = {
    async record(entry) {
      historyLog.push(clone(entry));
      return clone(entry);
    },
    async listByConversation(conversationId, options = {}) {
      const list = historyLog.filter((h) => h.conversationId === String(conversationId)).sort((a, b) => (a.at < b.at ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
  };

  const audit = {
    async record(entry) {
      auditLog.push(clone({ ...entry, at: entry.at ?? new Date().toISOString() }));
      return clone(entry);
    },
    async list(options = {}) {
      return (options.limit ? auditLog.slice(-options.limit) : [...auditLog]).map(clone);
    },
  };

  return {
    transfers,
    chunks,
    progress,
    history,
    audit,
    reset: () => {
      transfersById.clear();
      chunksByTransfer.clear();
      progressById.clear();
      historyLog.length = 0;
      auditLog.length = 0;
    },
  };
}

/**
 * @module media-delivery/repository/inMemory
 *
 * In-memory media-delivery repositories: the reference for the store contracts + the test/device
 * backend. Bundles the stores the engine needs:
 *
 * - `sessions`     — streaming session records.
 * - `transfers`    — progressive transfer records.
 * - `previews`     — preview/thumbnail records (metadata; generation is async).
 * - `availability` — per-device media-availability replicas + the offline media queue.
 * - history stores (`audit`) — the audit trail.
 *
 * Records are deep-copied in + out. Imports no driver, so the whole stack runs under `node --test`.
 *
 * ## sessions/transfers/previews contract  `create · findById · update · listBy*`
 * ## availability contract                  `upsert · findByDevice · enqueueOffline · drainOffline · listOffline`
 */

import { SessionNotFoundError, TransferNotFoundError } from "../errors.js";

const clone = (v) => (v == null ? v : structuredClone(v));

export function createInMemoryDeliveryRepository() {
  const sessionById = new Map();
  const transferById = new Map();
  const previewById = new Map();
  const previewByMediaKind = new Map(); // `${mediaId}:${kind}` → previewId
  const replicaByDevice = new Map();
  const offlineQueue = []; // { deviceId, mediaId, priority, at }
  const auditLog = [];

  const makeEntity = (map, NotFound, name) => ({
    async create(record, idKey) {
      map.set(String(record[idKey]), clone(record));
      return clone(record);
    },
    async findById(id) {
      const r = map.get(String(id));
      return r ? clone(r) : null;
    },
    async update(id, patch) {
      const existing = map.get(String(id));
      if (!existing) throw new NotFound(`${name} not found`, { details: { id } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      map.set(String(id), clone(updated));
      return clone(updated);
    },
    async delete(id) {
      return map.delete(String(id));
    },
  });

  const sessionsBase = makeEntity(sessionById, SessionNotFoundError, "Session");
  const sessions = {
    create: (r) => sessionsBase.create(r, "sessionId"),
    findById: sessionsBase.findById,
    update: sessionsBase.update,
    delete: sessionsBase.delete,
    async listByDevice(deviceId, { limit } = {}) {
      const list = [...sessionById.values()].filter((s) => s.deviceId === String(deviceId)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return (limit ? list.slice(0, limit) : list).map(clone);
    },
    async listByMedia(mediaId) {
      return [...sessionById.values()].filter((s) => s.mediaId === String(mediaId)).map(clone);
    },
  };

  const transfersBase = makeEntity(transferById, TransferNotFoundError, "Transfer");
  const transfers = {
    create: (r) => transfersBase.create(r, "transferId"),
    findById: transfersBase.findById,
    update: transfersBase.update,
    delete: transfersBase.delete,
    async listByDevice(deviceId, { state, limit } = {}) {
      let list = [...transferById.values()].filter((t) => t.deviceId === String(deviceId));
      if (state) list = list.filter((t) => t.state === state);
      list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return (limit ? list.slice(0, limit) : list).map(clone);
    },
    async listByMedia(mediaId) {
      return [...transferById.values()].filter((t) => t.mediaId === String(mediaId)).map(clone);
    },
  };

  const previews = {
    async create(record) {
      previewById.set(String(record.previewId), clone(record));
      previewByMediaKind.set(`${record.mediaId}:${record.kind}`, record.previewId);
      return clone(record);
    },
    async findById(previewId) {
      const p = previewById.get(String(previewId));
      return p ? clone(p) : null;
    },
    async findByMediaKind(mediaId, kind) {
      const id = previewByMediaKind.get(`${mediaId}:${kind}`);
      return id ? clone(previewById.get(id)) : null;
    },
    async update(previewId, patch) {
      const existing = previewById.get(String(previewId));
      if (!existing) return null;
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      previewById.set(String(previewId), clone(updated));
      return clone(updated);
    },
    async listByMedia(mediaId) {
      return [...previewById.values()].filter((p) => p.mediaId === String(mediaId)).map(clone);
    },
  };

  const availability = {
    async upsert(replica) {
      replicaByDevice.set(String(replica.deviceId), clone(replica));
      return clone(replica);
    },
    async findByDevice(deviceId) {
      const r = replicaByDevice.get(String(deviceId));
      return r ? clone(r) : null;
    },
    async enqueueOffline(entry) {
      offlineQueue.push(clone({ ...entry, at: entry.at ?? new Date().toISOString() }));
      return clone(entry);
    },
    async listOffline(deviceId) {
      return offlineQueue.filter((e) => e.deviceId === String(deviceId)).map(clone);
    },
    async drainOffline(deviceId) {
      const drained = [];
      for (let i = offlineQueue.length - 1; i >= 0; i--) if (offlineQueue[i].deviceId === String(deviceId)) drained.unshift(...offlineQueue.splice(i, 1));
      return drained.map(clone);
    },
    async countOffline(deviceId) {
      return offlineQueue.filter((e) => e.deviceId === String(deviceId)).length;
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
    sessions,
    transfers,
    previews,
    availability,
    audit,
    reset: () => {
      sessionById.clear();
      transferById.clear();
      previewById.clear();
      previewByMediaKind.clear();
      replicaByDevice.clear();
      offlineQueue.length = 0;
      auditLog.length = 0;
    },
  };
}

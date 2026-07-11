/**
 * @module replication/repository/inMemory
 *
 * In-memory replication repositories: the reference for the store contracts + the test/device backend.
 * Bundles the stores the manager needs:
 *
 * - `replicas`        — replica snapshots (rich version records).
 * - `conflictHistory` — detected/resolved conflicts.
 * - `mergeHistory`    — merges.
 * - `versionHistory`  — per-entity version evolution.
 * - `deltaHistory`    — delta replications.
 * - `replicaHistory`  — replica-lifecycle audit.
 * - `audit`           — free-form audit.
 *
 * Records are deep-copied in + out. Imports no driver, so the whole stack runs under `node --test`.
 *
 * ## replicas contract  `upsert · findById · findByDevice · listByUser · update · delete`
 */

import { ReplicaNotFoundError } from "../errors.js";

const clone = (v) => (v == null ? v : structuredClone(v));

export function createInMemoryReplicationRepository() {
  const replicaById = new Map();
  const replicaByDevice = new Map();
  const logs = { conflictHistory: [], mergeHistory: [], versionHistory: [], deltaHistory: [], replicaHistory: [], audit: [] };

  const replicas = {
    async upsert(replica) {
      replicaById.set(replica.replicaId, clone(replica));
      replicaByDevice.set(String(replica.deviceId), replica.replicaId);
      return clone(replica);
    },
    async findById(replicaId) {
      const r = replicaById.get(String(replicaId));
      return r ? clone(r) : null;
    },
    async findByDevice(deviceId) {
      const id = replicaByDevice.get(String(deviceId));
      return id ? clone(replicaById.get(id)) : null;
    },
    async listByUser(userId) {
      return [...replicaById.values()].filter((r) => r.userId === String(userId)).map(clone);
    },
    async update(replicaId, patch) {
      const existing = replicaById.get(String(replicaId));
      if (!existing) throw new ReplicaNotFoundError("Replica not found", { details: { replicaId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      replicaById.set(String(replicaId), clone(updated));
      return clone(updated);
    },
    async delete(replicaId) {
      const r = replicaById.get(String(replicaId));
      if (r) replicaByDevice.delete(String(r.deviceId));
      return replicaById.delete(String(replicaId));
    },
    async countByUser(userId) {
      return [...replicaById.values()].filter((r) => r.userId === String(userId)).length;
    },
  };

  const makeHistory = (key) => ({
    async record(entry) {
      logs[key].push(clone({ ...entry, at: entry.at ?? new Date().toISOString() }));
      return clone(entry);
    },
    async listByReplica(replicaId, options = {}) {
      const id = String(replicaId);
      const list = logs[key].filter((e) => e.replicaId === id || e.sourceReplicaId === id || e.targetReplicaId === id).sort((a, b) => (a.at < b.at ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
    async list(options = {}) {
      const list = [...logs[key]].sort((a, b) => (a.at < b.at ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
  });

  return {
    replicas,
    conflictHistory: makeHistory("conflictHistory"),
    mergeHistory: makeHistory("mergeHistory"),
    versionHistory: makeHistory("versionHistory"),
    deltaHistory: makeHistory("deltaHistory"),
    replicaHistory: makeHistory("replicaHistory"),
    audit: makeHistory("audit"),
    reset: () => {
      replicaById.clear();
      replicaByDevice.clear();
      for (const k of Object.keys(logs)) logs[k].length = 0;
    },
  };
}

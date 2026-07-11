/**
 * @module synchronization/repository/inMemory
 *
 * In-memory synchronization repositories: the reference for the store contracts + the test/device
 * backend. Bundles the stores the manager needs:
 *
 * - `replicas`      — per-device replica state (version maps).
 * - `sessions`      — synchronization sessions.
 * - `plans`         — synchronization plans (deterministic, resumable).
 * - `deltaHistory`  — computed-delta audit trail.
 * - `progress`      — latest progress snapshot per session.
 * - `audit`         — synchronization-operation audit.
 *
 * Records are deep-copied in + out. Imports no driver, so the whole stack runs under `node --test`.
 *
 * ## replicas contract  `upsert · findById · findByDevice · listByUser · update · delete`
 * ## sessions contract  `create · findById · update · delete · listActive · listByReplica · listExpired · countByState`
 */

import { SessionNotFoundError } from "../errors.js";
import { ACTIVE_SESSION_STATES } from "../types/types.js";

const clone = (v) => (v == null ? v : structuredClone(v));
const ACTIVE = new Set(ACTIVE_SESSION_STATES);

export function createInMemorySyncRepository() {
  /** @type {Map<string, object>} replicaId -> replica */
  const replicaById = new Map();
  /** @type {Map<string, string>} deviceId -> replicaId */
  const replicaByDevice = new Map();
  /** @type {Map<string, object>} sessionId -> session */
  const sessionById = new Map();
  /** @type {Map<string, object>} sessionId -> plan */
  const planBySession = new Map();
  const deltaLog = [];
  const progressById = new Map();
  const auditLog = [];

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
      if (!existing) throw new SessionNotFoundError("Replica not found", { details: { replicaId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      replicaById.set(String(replicaId), clone(updated));
      return clone(updated);
    },
    async delete(replicaId) {
      const r = replicaById.get(String(replicaId));
      if (r) replicaByDevice.delete(String(r.deviceId));
      return replicaById.delete(String(replicaId));
    },
  };

  const sessions = {
    async create(s) {
      sessionById.set(s.sessionId, clone(s));
      return clone(s);
    },
    async findById(sessionId) {
      const s = sessionById.get(String(sessionId));
      return s ? clone(s) : null;
    },
    async update(sessionId, patch) {
      const existing = sessionById.get(String(sessionId));
      if (!existing) throw new SessionNotFoundError("Synchronization session not found", { details: { sessionId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      sessionById.set(String(sessionId), clone(updated));
      return clone(updated);
    },
    async delete(sessionId) {
      planBySession.delete(String(sessionId));
      progressById.delete(String(sessionId));
      return sessionById.delete(String(sessionId));
    },
    async listActive(filter = {}) {
      return [...sessionById.values()]
        .filter((s) => ACTIVE.has(s.state) && (!filter.deviceId || s.deviceId === String(filter.deviceId)) && (!filter.userId || s.userId === String(filter.userId)))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map(clone);
    },
    async listByReplica(replicaId, options = {}) {
      const id = String(replicaId);
      const list = [...sessionById.values()].filter((s) => s.sourceReplicaId === id || s.targetReplicaId === id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
    async listExpired(nowIso) {
      const now = new Date(nowIso ?? new Date().toISOString()).getTime();
      return [...sessionById.values()].filter((s) => ACTIVE.has(s.state) && s.expiresAt && new Date(s.expiresAt).getTime() <= now).map(clone);
    },
    async countByState() {
      const counts = {};
      for (const s of sessionById.values()) counts[s.state] = (counts[s.state] ?? 0) + 1;
      return counts;
    },
  };

  const plans = {
    async save(sessionId, plan) {
      planBySession.set(String(sessionId), clone(plan));
      return clone(plan);
    },
    async get(sessionId) {
      const p = planBySession.get(String(sessionId));
      return p ? clone(p) : null;
    },
    async findById(sessionId) {
      return plans.get(sessionId);
    },
  };

  const deltaHistory = {
    async record(entry) {
      deltaLog.push(clone({ ...entry, at: entry.at ?? new Date().toISOString() }));
      return clone(entry);
    },
    async listBySession(sessionId, options = {}) {
      const list = deltaLog.filter((d) => d.sessionId === String(sessionId)).sort((a, b) => (a.at < b.at ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
  };

  const progress = {
    async save(sessionId, snapshot) {
      progressById.set(String(sessionId), clone({ sessionId: String(sessionId), ...snapshot }));
      return clone(progressById.get(String(sessionId)));
    },
    async get(sessionId) {
      const p = progressById.get(String(sessionId));
      return p ? clone(p) : null;
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
    replicas,
    sessions,
    plans,
    deltaHistory,
    progress,
    audit,
    reset: () => {
      replicaById.clear();
      replicaByDevice.clear();
      sessionById.clear();
      planBySession.clear();
      deltaLog.length = 0;
      progressById.clear();
      auditLog.length = 0;
    },
  };
}

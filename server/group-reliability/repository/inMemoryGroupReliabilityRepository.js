/**
 * @module group-reliability/repository/inMemory
 *
 * In-memory group-reliability repositories: the reference for the store contracts + the test/device
 * backend. Bundles the stores the manager needs:
 *
 * - `records`         — group-operation reliability records (source of truth for reliability state).
 * - `recoveryHistory` — recovery attempt audit trail.
 * - `alerts`          — raised monitor alerts.
 * - `audit`           — group-operation audit trail (every mutating op).
 *
 * Records are deep-copied in + out. Imports no driver, so the whole stack runs under `node --test`.
 *
 * ## records contract  `create · findById · update · delete · listActive(deviceId?) · listByGroup · listByUser · listStalled(now,timeoutMs) · countByState`
 */

import { OperationNotFoundError } from "../errors.js";
import { ACTIVE_RELIABILITY_STATES } from "../types/types.js";

const clone = (v) => (v == null ? v : structuredClone(v));
const ACTIVE = new Set(ACTIVE_RELIABILITY_STATES);
const STALLABLE = new Set(["tracking", "degraded"]);

export function createInMemoryGroupReliabilityRepository() {
  const byId = new Map();
  const recoveryLog = [];
  const alertLog = [];
  const auditLog = [];

  const records = {
    async create(r) {
      byId.set(r.operationId, clone(r));
      return clone(r);
    },
    async findById(operationId) {
      const r = byId.get(String(operationId));
      return r ? clone(r) : null;
    },
    async update(operationId, patch) {
      const existing = byId.get(String(operationId));
      if (!existing) throw new OperationNotFoundError("Group operation record not found", { details: { operationId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      byId.set(String(operationId), clone(updated));
      return clone(updated);
    },
    async delete(operationId) {
      return byId.delete(String(operationId));
    },
    async listActive(deviceId) {
      const id = deviceId != null ? String(deviceId) : null;
      return [...byId.values()].filter((r) => ACTIVE.has(r.state) && (id === null || r.deviceId === id || r.userId === id)).map(clone);
    },
    async listByGroup(groupId, options = {}) {
      const id = String(groupId);
      let list = [...byId.values()].filter((r) => r.groupId === id);
      if (options.state) list = list.filter((r) => r.state === options.state);
      list.sort((a, b) => (a.registeredAt < b.registeredAt ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
    async listByUser(userId, options = {}) {
      const id = String(userId);
      let list = [...byId.values()].filter((r) => r.userId === id || r.deviceId === id);
      if (options.state) list = list.filter((r) => r.state === options.state);
      list.sort((a, b) => (a.registeredAt < b.registeredAt ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
    async listStalled(now, timeoutMs) {
      const t = Number(now ?? Date.now());
      return [...byId.values()].filter((r) => STALLABLE.has(r.state) && r.lastActivityAt && t - new Date(r.lastActivityAt).getTime() >= timeoutMs).map(clone);
    },
    async listExpired(nowIso) {
      const now = new Date(nowIso ?? new Date().toISOString()).getTime();
      return [...byId.values()].filter((r) => ACTIVE.has(r.state) && r.expiresAt && new Date(r.expiresAt).getTime() <= now).map(clone);
    },
    async countByState() {
      const counts = {};
      for (const r of byId.values()) counts[r.state] = (counts[r.state] ?? 0) + 1;
      return counts;
    },
  };

  const recoveryHistory = {
    async record(entry) {
      recoveryLog.push(clone({ ...entry, at: entry.at ?? new Date().toISOString() }));
      return clone(entry);
    },
    async listByOperation(operationId, options = {}) {
      const list = recoveryLog.filter((e) => e.operationId === String(operationId)).sort((a, b) => (a.at < b.at ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
  };

  const alerts = {
    async record(alert) {
      alertLog.push(clone(alert));
      return clone(alert);
    },
    async list(options = {}) {
      const list = [...alertLog].sort((a, b) => (a.at < b.at ? 1 : -1));
      const start = options.offset ?? 0;
      return { total: alertLog.length, alerts: list.slice(start, start + (options.limit ?? 50)).map(clone) };
    },
  };

  const audit = {
    async record(entry) {
      auditLog.push(clone({ ...entry, at: entry.at ?? new Date().toISOString() }));
      return clone(entry);
    },
    async listByGroup(groupId, options = {}) {
      const list = auditLog.filter((e) => e.groupId === String(groupId)).sort((a, b) => (a.at < b.at ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
    async list(options = {}) {
      return (options.limit ? auditLog.slice(-options.limit) : [...auditLog]).map(clone);
    },
  };

  return {
    records,
    recoveryHistory,
    alerts,
    audit,
    reset: () => {
      byId.clear();
      recoveryLog.length = 0;
      alertLog.length = 0;
      auditLog.length = 0;
    },
  };
}

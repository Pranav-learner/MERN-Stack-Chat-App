/**
 * @module transport-reliability/repository/inMemory
 *
 * In-memory reliability repositories: the reference for the store contracts + the test/device backend.
 * Bundles the stores the manager needs:
 *
 * - `records`          — transfer reliability records (source of truth for reliability state).
 * - `recoveryHistory`  — recovery attempt audit trail.
 * - `migrationHistory` — connection-migration audit trail.
 * - `alerts`           — raised monitor alerts.
 * - `audit`            — transport-operation audit.
 *
 * Records are deep-copied in + out. Imports no driver, so the whole stack runs under `node --test`.
 *
 * ## records contract (shared with Mongo)
 * `create · findById · update · delete · listActive(deviceId?) · listByParticipant(deviceId,{state,limit}) · listStalled(now,timeoutMs) · countByState`
 */

import { TransferRecordNotFoundError } from "../errors.js";
import { ACTIVE_RELIABILITY_STATES } from "../types/types.js";

const clone = (v) => (v == null ? v : structuredClone(v));
const ACTIVE = new Set(ACTIVE_RELIABILITY_STATES);
// Only these states can be "stalled" (still progressing).
const STALLABLE = new Set(["tracking", "degraded"]);

export function createInMemoryReliabilityRepository() {
  /** @type {Map<string, object>} transferId -> record */
  const byId = new Map();
  const recoveryLog = [];
  const migrationLog = [];
  const alertLog = [];
  const auditLog = [];

  const records = {
    async create(r) {
      byId.set(r.transferId, clone(r));
      return clone(r);
    },
    async findById(transferId) {
      const r = byId.get(String(transferId));
      return r ? clone(r) : null;
    },
    async update(transferId, patch) {
      const key = String(transferId);
      const existing = byId.get(key);
      if (!existing) throw new TransferRecordNotFoundError("Transfer reliability record not found", { details: { transferId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      byId.set(key, clone(updated));
      return clone(updated);
    },
    async delete(transferId) {
      return byId.delete(String(transferId));
    },
    async listActive(deviceId) {
      const id = deviceId != null ? String(deviceId) : null;
      return [...byId.values()].filter((r) => ACTIVE.has(r.state) && (id === null || r.senderDeviceId === id || r.receiverDeviceId === id)).map(clone);
    },
    async listByParticipant(deviceId, options = {}) {
      const id = String(deviceId);
      let list = [...byId.values()].filter((r) => r.senderDeviceId === id || r.receiverDeviceId === id);
      if (options.state) list = list.filter((r) => r.state === options.state);
      list.sort((a, b) => (a.registeredAt < b.registeredAt ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
    async listStalled(now, timeoutMs) {
      const t = Number(now ?? Date.now());
      return [...byId.values()]
        .filter((r) => STALLABLE.has(r.state) && r.lastActivityAt && t - new Date(r.lastActivityAt).getTime() >= timeoutMs)
        .map(clone);
    },
    async countByState() {
      const counts = {};
      for (const r of byId.values()) counts[r.state] = (counts[r.state] ?? 0) + 1;
      return counts;
    },
    async listAll() {
      return [...byId.values()].map(clone);
    },
  };

  const recoveryHistory = {
    async record(entry) {
      recoveryLog.push(clone({ ...entry, at: entry.at ?? new Date().toISOString() }));
      return clone(entry);
    },
    async listByTransfer(transferId, options = {}) {
      const list = recoveryLog.filter((e) => e.transferId === String(transferId)).sort((a, b) => (a.at < b.at ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
  };

  const migrationHistory = {
    async record(entry) {
      migrationLog.push(clone({ ...entry, at: entry.at ?? new Date().toISOString() }));
      return clone(entry);
    },
    async listByTransfer(transferId, options = {}) {
      const list = migrationLog.filter((e) => e.transferId === String(transferId)).sort((a, b) => (a.at < b.at ? 1 : -1));
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
    async list(options = {}) {
      return (options.limit ? auditLog.slice(-options.limit) : [...auditLog]).map(clone);
    },
  };

  return {
    records,
    recoveryHistory,
    migrationHistory,
    alerts,
    audit,
    reset: () => {
      byId.clear();
      recoveryLog.length = 0;
      migrationLog.length = 0;
      alertLog.length = 0;
      auditLog.length = 0;
    },
  };
}

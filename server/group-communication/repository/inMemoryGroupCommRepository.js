/**
 * @module group-communication/repository/inMemory
 *
 * In-memory group-communication repositories: the reference for the store contracts + the test/device
 * backend. Bundles the stores the engine needs:
 *
 * - `keys`         — group-key epoch metadata (fingerprints + versions; NO key bytes).
 * - `messages`     — group message records (opaque ciphertext).
 * - `fanoutPlans`  — fan-out delivery plans + legs.
 * - `replicas`     — per-device group-communication replicas.
 * - `pendingQueue` — deferred deliveries for offline devices.
 * - history stores (`keyAudit`, `deliveryAudit`, `syncHistory`, `audit`) — the audit trail.
 *
 * Records are deep-copied in + out. Imports no driver, so the whole stack runs under `node --test`.
 *
 * ## keys contract        `create · findActive · findByVersion · listByGroup · update`
 * ## messages contract    `create · findById · listByGroup · listAfter`
 * ## fanoutPlans contract `create · findById · findByMessage · listByGroup · update`
 * ## replicas contract    `upsert · findByDevice · listByGroup · update`
 */

import { GroupKeyState } from "../types/types.js";

const clone = (v) => (v == null ? v : structuredClone(v));

export function createInMemoryGroupCommRepository() {
  const keysByGroup = new Map(); // groupId → Map(keyVersion → record)
  const messageById = new Map();
  const planById = new Map();
  const planByMessage = new Map();
  const replicaByDevice = new Map(); // `${groupId}::${deviceId}` → replica
  const pending = []; // deferred delivery legs
  const logs = { keyAudit: [], deliveryAudit: [], syncHistory: [], audit: [] };

  const rk = (groupId, deviceId) => `${String(groupId)}::${String(deviceId)}`;

  const keys = {
    async create(record) {
      const byVersion = keysByGroup.get(String(record.groupId)) ?? new Map();
      byVersion.set(record.keyVersion, clone(record));
      keysByGroup.set(String(record.groupId), byVersion);
      return clone(record);
    },
    async findActive(groupId) {
      const byVersion = keysByGroup.get(String(groupId));
      if (!byVersion) return null;
      const active = [...byVersion.values()].filter((k) => k.state === GroupKeyState.ACTIVE).sort((a, b) => b.keyVersion - a.keyVersion)[0];
      return active ? clone(active) : null;
    },
    async findByVersion(groupId, keyVersion) {
      const byVersion = keysByGroup.get(String(groupId));
      const k = byVersion?.get(Number(keyVersion));
      return k ? clone(k) : null;
    },
    async listByGroup(groupId) {
      const byVersion = keysByGroup.get(String(groupId));
      return byVersion ? [...byVersion.values()].sort((a, b) => b.keyVersion - a.keyVersion).map(clone) : [];
    },
    async update(groupId, keyVersion, patch) {
      const byVersion = keysByGroup.get(String(groupId));
      const existing = byVersion?.get(Number(keyVersion));
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      byVersion.set(Number(keyVersion), clone(updated));
      return clone(updated);
    },
  };

  const messages = {
    async create(message) {
      messageById.set(String(message.messageId), clone(message));
      return clone(message);
    },
    async findById(messageId) {
      const m = messageById.get(String(messageId));
      return m ? clone(m) : null;
    },
    async listByGroup(groupId, { limit, offset = 0 } = {}) {
      const list = [...messageById.values()].filter((m) => m.groupId === String(groupId)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const sliced = limit ? list.slice(offset, offset + limit) : list;
      return sliced.map(clone);
    },
    async listAfter(groupId, cursorAt) {
      return [...messageById.values()].filter((m) => m.groupId === String(groupId) && (!cursorAt || m.createdAt > cursorAt)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).map(clone);
    },
    async count(groupId) {
      return [...messageById.values()].filter((m) => m.groupId === String(groupId)).length;
    },
  };

  const fanoutPlans = {
    async create(plan) {
      planById.set(String(plan.planId), clone(plan));
      planByMessage.set(String(plan.messageId), plan.planId);
      return clone(plan);
    },
    async findById(planId) {
      const p = planById.get(String(planId));
      return p ? clone(p) : null;
    },
    async findByMessage(messageId) {
      const id = planByMessage.get(String(messageId));
      return id ? clone(planById.get(id)) : null;
    },
    async listByGroup(groupId, { limit } = {}) {
      const list = [...planById.values()].filter((p) => p.groupId === String(groupId)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return (limit ? list.slice(0, limit) : list).map(clone);
    },
    async update(planId, patch) {
      const existing = planById.get(String(planId));
      if (!existing) return null;
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      planById.set(String(planId), clone(updated));
      return clone(updated);
    },
  };

  const replicas = {
    async upsert(replica) {
      replicaByDevice.set(rk(replica.groupId, replica.deviceId), clone(replica));
      return clone(replica);
    },
    async findByDevice(groupId, deviceId) {
      const r = replicaByDevice.get(rk(groupId, deviceId));
      return r ? clone(r) : null;
    },
    async listByGroup(groupId) {
      return [...replicaByDevice.values()].filter((r) => r.groupId === String(groupId)).map(clone);
    },
    async update(groupId, deviceId, patch) {
      const existing = replicaByDevice.get(rk(groupId, deviceId));
      if (!existing) return null;
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      replicaByDevice.set(rk(groupId, deviceId), clone(updated));
      return clone(updated);
    },
  };

  const pendingQueue = {
    async enqueue(entry) {
      pending.push(clone({ ...entry, at: entry.at ?? new Date().toISOString() }));
      return clone(entry);
    },
    async listByDevice(groupId, deviceId) {
      return pending.filter((e) => e.groupId === String(groupId) && e.deviceId === String(deviceId)).map(clone);
    },
    async listByGroup(groupId) {
      return pending.filter((e) => e.groupId === String(groupId)).map(clone);
    },
    async drainDevice(groupId, deviceId) {
      const drained = [];
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].groupId === String(groupId) && pending[i].deviceId === String(deviceId)) drained.unshift(...pending.splice(i, 1));
      }
      return drained.map(clone);
    },
    async count(groupId) {
      return pending.filter((e) => e.groupId === String(groupId)).length;
    },
  };

  const makeHistory = (key) => ({
    async record(entry) {
      logs[key].push(clone({ ...entry, at: entry.at ?? new Date().toISOString() }));
      return clone(entry);
    },
    async listByGroup(groupId, options = {}) {
      const list = logs[key].filter((e) => e.groupId === String(groupId)).sort((a, b) => (a.at < b.at ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
    async list(options = {}) {
      const list = [...logs[key]].sort((a, b) => (a.at < b.at ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
  });

  return {
    keys,
    messages,
    fanoutPlans,
    replicas,
    pendingQueue,
    keyAudit: makeHistory("keyAudit"),
    deliveryAudit: makeHistory("deliveryAudit"),
    syncHistory: makeHistory("syncHistory"),
    audit: makeHistory("audit"),
    reset: () => {
      keysByGroup.clear();
      messageById.clear();
      planById.clear();
      planByMessage.clear();
      replicaByDevice.clear();
      pending.length = 0;
      for (const k of Object.keys(logs)) logs[k].length = 0;
    },
  };
}

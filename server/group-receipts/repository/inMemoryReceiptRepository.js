/**
 * @module group-receipts/repository/inMemory
 *
 * In-memory receipt repositories: the reference for the store contracts + the test/device backend.
 * Bundles the stores the manager needs:
 *
 * - `aggregates`     — one incremental aggregate per message (source of truth for the receipt; O(1)).
 * - `memberReceipts` — one per (message, member) delivery + read record (multi-device).
 * - `analytics`      — cached analytics snapshots (optional).
 * - history stores (`receiptHistory`, `audit`) — the audit trail.
 *
 * Records are deep-copied in + out. Imports no driver, so the whole stack runs under `node --test`.
 *
 * ## aggregates contract      `create · findById · update · delete · listByGroup`
 * ## memberReceipts contract  `upsert · find · listByMessage · countByMessage`
 */

import { ReceiptNotFoundError } from "../errors.js";

const clone = (v) => (v == null ? v : structuredClone(v));

export function createInMemoryReceiptRepository() {
  const aggregateById = new Map();
  const memberById = new Map(); // `${messageId}::${memberId}` → record
  const membersByMessage = new Map(); // messageId → Set(key)
  const analyticsById = new Map();
  const logs = { receiptHistory: [], audit: [] };

  const mkKey = (messageId, memberId) => `${String(messageId)}::${String(memberId)}`;

  const aggregates = {
    async create(aggregate) {
      aggregateById.set(String(aggregate.messageId), clone(aggregate));
      return clone(aggregate);
    },
    async findById(messageId) {
      const a = aggregateById.get(String(messageId));
      return a ? clone(a) : null;
    },
    async update(messageId, patch) {
      const existing = aggregateById.get(String(messageId));
      if (!existing) throw new ReceiptNotFoundError("Receipt aggregate not found", { details: { messageId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      aggregateById.set(String(messageId), clone(updated));
      return clone(updated);
    },
    async delete(messageId) {
      return aggregateById.delete(String(messageId));
    },
    async listByGroup(groupId, { limit } = {}) {
      const list = [...aggregateById.values()].filter((a) => a.groupId === String(groupId)).sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
      return (limit ? list.slice(0, limit) : list).map(clone);
    },
  };

  const memberReceipts = {
    async upsert(record) {
      const key = mkKey(record.messageId, record.memberId);
      memberById.set(key, clone(record));
      let set = membersByMessage.get(String(record.messageId));
      if (!set) {
        set = new Set();
        membersByMessage.set(String(record.messageId), set);
      }
      set.add(key);
      return clone(record);
    },
    async find(messageId, memberId) {
      const r = memberById.get(mkKey(messageId, memberId));
      return r ? clone(r) : null;
    },
    async listByMessage(messageId, { filter, limit, offset = 0 } = {}) {
      const set = membersByMessage.get(String(messageId));
      if (!set) return [];
      let list = [...set].map((k) => memberById.get(k)).filter(Boolean);
      if (filter === "read") list = list.filter((r) => r.memberRead);
      else if (filter === "delivered") list = list.filter((r) => r.memberDelivered);
      else if (filter === "pending") list = list.filter((r) => !r.memberDelivered);
      list.sort((a, b) => (a.memberId < b.memberId ? -1 : 1));
      const sliced = limit ? list.slice(offset, offset + limit) : list;
      return sliced.map(clone);
    },
    async countByMessage(messageId, filter) {
      const set = membersByMessage.get(String(messageId));
      if (!set) return 0;
      if (!filter) return set.size;
      let n = 0;
      for (const k of set) {
        const r = memberById.get(k);
        if (filter === "read" && r?.memberRead) n++;
        else if (filter === "delivered" && r?.memberDelivered) n++;
        else if (filter === "pending" && !r?.memberDelivered) n++;
      }
      return n;
    },
  };

  const analytics = {
    async upsert(snapshot) {
      analyticsById.set(String(snapshot.messageId), clone(snapshot));
      return clone(snapshot);
    },
    async findById(messageId) {
      const a = analyticsById.get(String(messageId));
      return a ? clone(a) : null;
    },
  };

  const makeHistory = (key) => ({
    async record(entry) {
      logs[key].push(clone({ ...entry, at: entry.at ?? new Date().toISOString() }));
      return clone(entry);
    },
    async listByMessage(messageId, options = {}) {
      const list = logs[key].filter((e) => e.messageId === String(messageId)).sort((a, b) => (a.at < b.at ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
    async list(options = {}) {
      return (options.limit ? logs[key].slice(-options.limit) : [...logs[key]]).map(clone);
    },
  });

  return {
    aggregates,
    memberReceipts,
    analytics,
    receiptHistory: makeHistory("receiptHistory"),
    audit: makeHistory("audit"),
    reset: () => {
      aggregateById.clear();
      memberById.clear();
      membersByMessage.clear();
      analyticsById.clear();
      for (const k of Object.keys(logs)) logs[k].length = 0;
    },
  };
}

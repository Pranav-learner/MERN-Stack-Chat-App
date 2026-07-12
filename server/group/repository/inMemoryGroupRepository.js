/**
 * @module group/repository/inMemory
 *
 * In-memory group repositories: the reference for the store contracts + the test/device backend.
 * Bundles the stores the manager needs:
 *
 * - `groups`       — the group entity (identity + metadata + versions + permission overrides).
 * - `memberships`  — one record per (group, member): role + lifecycle state + version.
 * - `replicaState` — the per-group replica snapshot.
 * - history stores (`versionHistory`, `metadataHistory`, `roleHistory`, `permissionHistory`,
 *   `membershipHistory`, `audit`) — the append-only audit trail, keyed by group.
 *
 * Records are deep-copied in + out, so callers can never mutate stored state by reference. Imports no
 * driver, so the whole stack runs under `node --test`.
 *
 * ## groups contract       `create · findById · update · delete · listByOwner · exists`
 * ## memberships contract  `upsert · findById · findByGroupAndMember · listByGroup · listByMember · update · delete · countByGroup`
 * ## replicaState contract `upsert · findByGroup · update`
 */

import { GroupNotFoundError, MembershipNotFoundError } from "../errors.js";

const clone = (v) => (v == null ? v : structuredClone(v));

export function createInMemoryGroupRepository() {
  const groupById = new Map();
  const membershipById = new Map();
  const membershipByGroupMember = new Map(); // `${groupId}::${memberId}` → membershipId
  const replicaByGroup = new Map();
  const logs = { versionHistory: [], metadataHistory: [], roleHistory: [], permissionHistory: [], membershipHistory: [], audit: [] };

  const mkKey = (groupId, memberId) => `${String(groupId)}::${String(memberId)}`;

  const groups = {
    async create(group) {
      groupById.set(String(group.groupId), clone(group));
      return clone(group);
    },
    async findById(groupId) {
      const g = groupById.get(String(groupId));
      return g ? clone(g) : null;
    },
    async update(groupId, patch) {
      const existing = groupById.get(String(groupId));
      if (!existing) throw new GroupNotFoundError("Group not found", { details: { groupId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      groupById.set(String(groupId), clone(updated));
      return clone(updated);
    },
    async delete(groupId) {
      return groupById.delete(String(groupId));
    },
    async listByOwner(ownerId) {
      return [...groupById.values()].filter((g) => g.ownerId === String(ownerId)).map(clone);
    },
    async exists(groupId) {
      return groupById.has(String(groupId));
    },
  };

  const memberships = {
    async upsert(membership) {
      membershipById.set(String(membership.membershipId), clone(membership));
      membershipByGroupMember.set(mkKey(membership.groupId, membership.memberId), membership.membershipId);
      return clone(membership);
    },
    async findById(membershipId) {
      const m = membershipById.get(String(membershipId));
      return m ? clone(m) : null;
    },
    async findByGroupAndMember(groupId, memberId) {
      const id = membershipByGroupMember.get(mkKey(groupId, memberId));
      return id ? clone(membershipById.get(id)) : null;
    },
    async listByGroup(groupId, { states } = {}) {
      let list = [...membershipById.values()].filter((m) => m.groupId === String(groupId));
      if (states) list = list.filter((m) => states.includes(m.state));
      return list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).map(clone);
    },
    async listByMember(memberId, { states } = {}) {
      let list = [...membershipById.values()].filter((m) => m.memberId === String(memberId));
      if (states) list = list.filter((m) => states.includes(m.state));
      return list.map(clone);
    },
    async update(membershipId, patch) {
      const existing = membershipById.get(String(membershipId));
      if (!existing) throw new MembershipNotFoundError("Membership not found", { details: { membershipId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      membershipById.set(String(membershipId), clone(updated));
      membershipByGroupMember.set(mkKey(updated.groupId, updated.memberId), updated.membershipId);
      return clone(updated);
    },
    async delete(membershipId) {
      const m = membershipById.get(String(membershipId));
      if (m) membershipByGroupMember.delete(mkKey(m.groupId, m.memberId));
      return membershipById.delete(String(membershipId));
    },
    async countByGroup(groupId, { states } = {}) {
      return [...membershipById.values()].filter((m) => m.groupId === String(groupId) && (!states || states.includes(m.state))).length;
    },
  };

  const replicaState = {
    async upsert(snapshot) {
      replicaByGroup.set(String(snapshot.groupId), clone(snapshot));
      return clone(snapshot);
    },
    async findByGroup(groupId) {
      const r = replicaByGroup.get(String(groupId));
      return r ? clone(r) : null;
    },
    async update(groupId, patch) {
      const existing = replicaByGroup.get(String(groupId)) ?? { groupId: String(groupId) };
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      replicaByGroup.set(String(groupId), clone(updated));
      return clone(updated);
    },
  };

  const makeHistory = (key) => ({
    async record(entry) {
      logs[key].push(clone({ ...entry, at: entry.at ?? new Date().toISOString() }));
      return clone(entry);
    },
    async listByGroup(groupId, options = {}) {
      const id = String(groupId);
      const list = logs[key].filter((e) => e.groupId === id).sort((a, b) => (a.at < b.at ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
    async list(options = {}) {
      const list = [...logs[key]].sort((a, b) => (a.at < b.at ? 1 : -1));
      return (options.limit ? list.slice(0, options.limit) : list).map(clone);
    },
  });

  return {
    groups,
    memberships,
    replicaState,
    versionHistory: makeHistory("versionHistory"),
    metadataHistory: makeHistory("metadataHistory"),
    roleHistory: makeHistory("roleHistory"),
    permissionHistory: makeHistory("permissionHistory"),
    membershipHistory: makeHistory("membershipHistory"),
    audit: makeHistory("audit"),
    reset: () => {
      groupById.clear();
      membershipById.clear();
      membershipByGroupMember.clear();
      replicaByGroup.clear();
      for (const k of Object.keys(logs)) logs[k].length = 0;
    },
  };
}

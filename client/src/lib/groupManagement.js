/**
 * Client Group Management integration (Layer 10, Sprint 1).
 *
 * Drives the `/api/group-management` control plane: create/delete/archive groups, run the full
 * membership flow (invite → accept/reject, join → approve, leave/remove/ban/mute), transfer ownership,
 * change roles, update versioned metadata + permissions, and read members / roles / permissions /
 * details / versions / replica state / history. It treats a group as a first-class distributed entity
 * the UI renders + mutates, and surfaces membership / metadata / role / version / replica changes to the
 * app via subscribable hooks.
 *
 * @security This lib exchanges CONTROL-PLANE metadata ONLY with the engine — ids, roles, states,
 * versions, counts, names — never message plaintext, ciphertext, or keys. Group *message* encryption is
 * a later sprint; the `onGroupMessaging` hook here is an inert seam that Sprint 2 wires up.
 *
 * @scope Sprint 1 = group foundation + membership + roles + permissions + metadata + versioning +
 * replica state. Group messaging / encryption / fan-out are NOT implemented.
 *
 * @example
 * ```js
 * import { GroupManagementClient } from "../lib/groupManagement.js";
 * const groups = new GroupManagementClient({ axios, userId });
 * groups.onMembershipChange((m) => refreshRoster(m));
 * const g = await groups.createGroup({ name: "Design", description: "UX squad" });
 * await groups.invite(g.groupId, "bob", "member");
 * ```
 */

const BASE = "/api/group-management";

export class GroupManagementClient {
  /**
   * @param {object} deps
   * @param {import("axios").AxiosInstance} deps.axios auth-bearing axios instance
   * @param {string} [deps.userId] this user's id (for local reasoning; the server derives the actor from JWT)
   * @param {object} [deps.options]
   */
  constructor(deps) {
    if (!deps?.axios) throw new Error("GroupManagementClient requires { axios }");
    this.axios = deps.axios;
    this.userId = deps.userId != null ? String(deps.userId) : null;
    this.options = { autoRefreshMs: 60_000, ...(deps.options ?? {}) };
    this._membershipHandlers = new Set();
    this._metadataHandlers = new Set();
    this._roleHandlers = new Set();
    this._versionHandlers = new Set();
    this._replicaHandlers = new Set();
    this._messagingHandlers = new Set(); // FUTURE group-messaging seam (inert)
    this._autoTimers = new Map();
  }

  // === subscriptions ========================================================

  /** Subscribe to membership changes (invite/join/leave/remove/role). @returns {() => void} */
  onMembershipChange(handler) {
    this._membershipHandlers.add(handler);
    return () => this._membershipHandlers.delete(handler);
  }
  /** Subscribe to metadata updates. @returns {() => void} */
  onMetadataChange(handler) {
    this._metadataHandlers.add(handler);
    return () => this._metadataHandlers.delete(handler);
  }
  /** Subscribe to role/permission changes. @returns {() => void} */
  onRoleChange(handler) {
    this._roleHandlers.add(handler);
    return () => this._roleHandlers.delete(handler);
  }
  /** Subscribe to group version updates. @returns {() => void} */
  onVersionChange(handler) {
    this._versionHandlers.add(handler);
    return () => this._versionHandlers.delete(handler);
  }
  /** Subscribe to replica-state refreshes. @returns {() => void} */
  onReplicaChange(handler) {
    this._replicaHandlers.add(handler);
    return () => this._replicaHandlers.delete(handler);
  }
  /** FUTURE group-messaging seam — inert in Sprint 1. @returns {() => void} */
  onGroupMessaging(handler) {
    this._messagingHandlers.add(handler);
    return () => this._messagingHandlers.delete(handler);
  }

  // === group lifecycle ======================================================

  /** Create a group (the caller becomes owner). @param {{ name, description?, avatar?, tags?, visibility?, announcement?, permissionOverrides?, initialMembers? }} metadata */
  async createGroup(metadata = {}) {
    const { data } = await this.axios.post(`${BASE}/groups`, { metadata });
    this._emitVersion(data.group);
    return data.group;
  }

  /** Delete (soft) a group. */
  async deleteGroup(groupId) {
    const { data } = await this.axios.delete(`${BASE}/groups/${encodeURIComponent(groupId)}`);
    return data.group;
  }

  /** Archive / restore a group. */
  async archiveGroup(groupId) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/archive`);
    this._emitVersion(data.group);
    return data.group;
  }
  async restoreGroup(groupId) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/restore`);
    this._emitVersion(data.group);
    return data.group;
  }

  // === membership: invitations ==============================================

  /** Invite a member. */
  async invite(groupId, memberId, role) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/invite`, { memberId, role });
    this._emitMembership(data.membership);
    return data.membership;
  }
  /** Accept an invitation (self). */
  async acceptInvite(groupId) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/accept`);
    this._emitMembership(data.membership);
    return data.membership;
  }
  /** Reject an invitation (self). */
  async rejectInvite(groupId) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/reject`);
    this._emitMembership(data.membership);
    return data.membership;
  }

  // === membership: join / leave / moderation ================================

  /** Join a group (self). Public → active; else → pending. */
  async join(groupId) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/join`);
    this._emitMembership(data.membership);
    return data.membership;
  }
  /** Approve a pending join request. */
  async approveJoin(groupId, memberId) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/approve`, { memberId });
    this._emitMembership(data.membership);
    return data.membership;
  }
  /** Leave a group (self). */
  async leave(groupId) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/leave`);
    this._emitMembership(data.membership);
    return data.membership;
  }
  /** Remove / ban / mute / unmute a member. */
  async remove(groupId, memberId) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/remove`, { memberId });
    this._emitMembership(data.membership);
    return data.membership;
  }
  async ban(groupId, memberId) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/ban`, { memberId });
    this._emitMembership(data.membership);
    return data.membership;
  }
  async mute(groupId, memberId) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/mute`, { memberId });
    this._emitMembership(data.membership);
    return data.membership;
  }
  async unmute(groupId, memberId) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/unmute`, { memberId });
    this._emitMembership(data.membership);
    return data.membership;
  }

  // === ownership + roles ====================================================

  /** Transfer ownership to another member. */
  async transferOwnership(groupId, newOwnerId) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/transfer-ownership`, { newOwnerId });
    this._emitRole({ groupId, ownershipTransferredTo: newOwnerId });
    this._emitVersion(data.group);
    return data.group;
  }
  /** Change a member's role. */
  async changeRole(groupId, memberId, role) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/roles`, { memberId, role });
    this._emitRole(data.membership);
    this._emitMembership(data.membership);
    return data.membership;
  }

  // === metadata + permissions ===============================================

  /** Update group metadata (partial patch). */
  async updateMetadata(groupId, patch, expectedVersion) {
    const { data } = await this.axios.patch(`${BASE}/groups/${encodeURIComponent(groupId)}/metadata`, { patch, expectedVersion });
    this._emitMetadata(data.group);
    this._emitVersion(data.group);
    return data.group;
  }
  /** Set per-role permission overrides. */
  async updatePermissions(groupId, overrides) {
    const { data } = await this.axios.put(`${BASE}/groups/${encodeURIComponent(groupId)}/permissions`, { overrides });
    this._emitRole({ groupId, permissions: data.permissions });
    return data.permissions;
  }

  // === reads ================================================================

  async myGroups() {
    const { data } = await this.axios.get(`${BASE}/groups/mine`);
    return data.groups;
  }
  async getGroup(groupId) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}`);
    return data.group;
  }
  async getDetails(groupId) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/details`);
    return data.details;
  }
  async listMembers(groupId, { states, limit, offset } = {}) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/members`, { params: { states: states?.join(","), limit, offset } });
    return data;
  }
  async getRoles(groupId) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/roles`);
    return data.roles;
  }
  async getPermissions(groupId) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/permissions`);
    return data.permissions;
  }
  async getVersions(groupId) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/versions`);
    this._emitVersion({ groupId, versions: data.versions?.versions });
    return data.versions;
  }
  async getReplica(groupId, { refresh } = {}) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/replica`, { params: { refresh: refresh ? 1 : undefined } });
    this._emitReplica(data.replica);
    return data.replica;
  }
  async refreshReplica(groupId) {
    const { data } = await this.axios.post(`${BASE}/groups/${encodeURIComponent(groupId)}/replica/refresh`);
    this._emitReplica(data.replica);
    return data;
  }
  async getHistory(groupId, kind = "membership", limit) {
    const { data } = await this.axios.get(`${BASE}/groups/${encodeURIComponent(groupId)}/history/${kind}`, { params: { limit } });
    return data.history;
  }

  // === background refresh ===================================================

  /** Periodically refresh a group's replica (drift detection). Idempotent per group. */
  startAutoRefresh(groupId, params = {}) {
    if (this._autoTimers.has(groupId)) return;
    const intervalMs = params.intervalMs ?? this.options.autoRefreshMs;
    const timer = setInterval(() => this.getReplica(groupId, { refresh: true }).catch(() => {}), intervalMs);
    this._autoTimers.set(groupId, timer);
  }
  stopAutoRefresh(groupId) {
    const t = this._autoTimers.get(groupId);
    if (t) clearInterval(t);
    this._autoTimers.delete(groupId);
  }

  // === internals ============================================================

  _emitMembership(m) { this._fan(this._membershipHandlers, m); }
  _emitMetadata(g) { this._fan(this._metadataHandlers, g); }
  _emitRole(r) { this._fan(this._roleHandlers, r); }
  _emitVersion(g) { this._fan(this._versionHandlers, g); }
  _emitReplica(r) { this._fan(this._replicaHandlers, r); }
  _fan(handlers, payload) {
    for (const h of handlers) try { h(payload); } catch { /* ignore */ }
  }
}

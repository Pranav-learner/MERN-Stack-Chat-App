/**
 * @module group/manager
 *
 * The **Group Manager** — the reusable orchestrator for Layer 10, Sprint 1. It treats a Group as a
 * FIRST-CLASS DISTRIBUTED ENTITY and owns its whole control plane: identity + lifecycle, the membership
 * manager (create/delete group, invite/accept/reject, join/approve, leave/remove/ban/mute, transfer
 * ownership), role-based access control, a configurable permission system, versioned metadata, a
 * per-facet version vector, and a reconcilable replica snapshot. Every mutation is permission-checked,
 * lifecycle-validated, version-bumped, audited, and announced on the event bus.
 *
 * @important This subsystem is the FOUNDATION for future secure group messaging — it implements NO
 * group messaging, encryption, rekeying, fan-out, delivery tracking, or read receipts. Those consume
 * this manager's entities + events in a later sprint.
 *
 * @security Reasons over ids + roles + states + versions + non-secret metadata ONLY — never message
 * plaintext, ciphertext, or key material. Group encryption keys are derived later and never stored here.
 *
 * @concurrency Mutations are serialized per-group by a lightweight async mutex, so concurrent membership
 * updates + version bumps never interleave or lose a write (deterministic, monotonic versions).
 *
 * @example
 * ```js
 * const mgr = new GroupManager({ ...createInMemoryGroupRepository() });
 * const group = await mgr.createGroup({ ownerId: "alice", metadata: { name: "Design" } });
 * await mgr.inviteMember({ groupId: group.groupId, actorId: "alice", memberId: "bob" });
 * await mgr.acceptInvitation({ groupId: group.groupId, actorId: "bob", memberId: "bob" });
 * await mgr.changeRole({ groupId: group.groupId, actorId: "alice", memberId: "bob", role: "administrator" });
 * ```
 */

import crypto from "node:crypto";
import {
  GroupRole,
  GroupState,
  GroupVisibility,
  GroupPermission,
  MembershipState,
  GroupEventType,
  ACTIVE_MEMBERSHIP_STATES,
  DEFAULT_MAX_MEMBERS,
  VersionKind,
  GROUP_FRAMEWORK,
  GROUP_SCHEMA_VERSION,
} from "../types/types.js";
import {
  GroupError,
  DuplicateGroupError,
  DuplicateMembershipError,
  DuplicateInvitationError,
  PermissionDeniedError,
  OwnershipError,
  GroupStateError,
} from "../errors.js";
import { GroupEventBus } from "../events/events.js";
import { createVersionVector, bumpVersion, versionHistoryEntry, assertVersionMatch } from "../versions/versionManager.js";
import { createMetadata, applyMetadataPatch, metadataHistoryEntry } from "../metadata/metadata.js";
import { createMembership, transitionMembership, assignMembershipRole, membershipHistoryEntry } from "../membership/membership.js";
import { canAssignRole, canManageMember, validateRole } from "../roles/roles.js";
import { hasPermission, resolvePermissions, permissionMatrix, validatePermissionOverrides } from "../permissions/permissions.js";
import { assertGroupActive, assertGroupTransition, isActiveState, isTerminalState } from "../lifecycle/lifecycle.js";
import { buildReplicaState, diffReplica } from "../replicas/replicaState.js";
import {
  validateGroupCreation,
  validateRef,
  requireGroup,
  requireMembership,
  assertNotOwner,
  assertValidOwnershipTransfer,
  assertNoSecrets,
  normalizePagination,
  validateRepository,
} from "../validators/validators.js";
import {
  toPublicGroup,
  toGroupDetails,
  toMembershipView,
  toMemberList,
  toRoleView,
  toPermissionView,
  toVersionView,
  toReplicaView,
} from "../serializers/serializers.js";

export class GroupManager {
  constructor(deps = {}) {
    validateRepository(deps);
    this.groups = deps.groups;
    this.memberships = deps.memberships;
    this.replicaStates = deps.replicaState;
    this.stores = deps;
    this.events = deps.events ?? new GroupEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.maxMembers = deps.maxMembers ?? DEFAULT_MAX_MEMBERS;
    this.defaultVisibility = deps.defaultVisibility ?? GroupVisibility.PRIVATE;
    this._locks = new Map(); // groupId → tail promise (per-group serialization)
  }

  onEvent(type, handler) {
    return this.events.on(type, handler);
  }

  // === group lifecycle ======================================================

  /**
   * Create a group. The creator becomes the OWNER (an active membership). Optional `initialMembers` are
   * added as active members. @returns {Promise<object>} the public group DTO.
   */
  async createGroup(params) {
    validateGroupCreation(params);
    const groupId = params.groupId ?? this.idGenerator();
    if (await this.groups.exists(groupId)) throw new DuplicateGroupError("Group id already exists", { details: { groupId } });
    return this._withLock(groupId, async () => {
      const now = this._nowIso();
      const metadata = createMetadata({ ...(params.metadata ?? {}), visibility: params.metadata?.visibility ?? this.defaultVisibility }, now);
      const overrides = validatePermissionOverrides(params.permissionOverrides ?? {});
      const group = {
        groupId: String(groupId),
        ownerId: String(params.ownerId),
        state: GroupState.ACTIVE,
        metadata,
        visibility: metadata.visibility,
        versions: createVersionVector(),
        permissionOverrides: overrides,
        audit: { createdBy: String(params.ownerId), createdAt: now },
        createdAt: now,
        updatedAt: now,
        schemaVersion: GROUP_SCHEMA_VERSION,
      };
      assertNoSecrets(group, "group");
      const stored = await this.groups.create(group);

      // Owner membership.
      const owner = createMembership({ groupId, memberId: params.ownerId, role: GroupRole.OWNER, state: MembershipState.ACTIVE, invitedBy: params.ownerId, clock: this.clock, idGenerator: this.idGenerator });
      await this.memberships.upsert(owner);
      await this._recordMembership(groupId, { membership: owner, action: "created", toState: owner.state, toRole: owner.role, actorId: params.ownerId });

      // Optional initial members (added active by the owner).
      for (const m of params.initialMembers ?? []) {
        if (!m?.memberId || String(m.memberId) === String(params.ownerId)) continue;
        const role = m.role ? validateRole(m.role) : GroupRole.MEMBER;
        const mem = createMembership({ groupId, memberId: m.memberId, role, state: MembershipState.ACTIVE, invitedBy: params.ownerId, clock: this.clock, idGenerator: this.idGenerator });
        await this.memberships.upsert(mem);
        await this._recordMembership(groupId, { membership: mem, action: "created", toState: mem.state, toRole: mem.role, actorId: params.ownerId });
      }

      this.events.emit(GroupEventType.GROUP_CREATED, { groupId: stored.groupId, ownerId: stored.ownerId, name: metadata.name });
      await this._recordAudit(groupId, { actorId: params.ownerId, action: "group.created" });
      await this._refreshReplica(stored);
      const memberCount = await this._countActive(groupId);
      return toPublicGroup(stored, { memberCount });
    });
  }

  /** Soft-delete a group (owner only). Marks the entity + all memberships deleted. */
  async deleteGroup({ groupId, actorId }) {
    validateRef(groupId, "group identifier");
    return this._withLock(groupId, async () => {
      const group = requireGroup(await this.groups.findById(groupId), groupId);
      this._assertPermissionSync(group, await this._role(group, actorId), GroupPermission.DELETE_GROUP);
      const updated = await this._applyVersion(group, VersionKind.GROUP, { actorId, reason: "delete", patch: { state: GroupState.DELETED } });
      for (const m of await this.memberships.listByGroup(groupId)) {
        if (!isTerminalState(m.state)) {
          const next = transitionMembership(m, MembershipState.DELETED, this._nowIso());
          await this.memberships.update(m.membershipId, { state: next.state, version: next.version, updatedAt: next.updatedAt });
        }
      }
      this.events.emit(GroupEventType.GROUP_DELETED, { groupId: updated.groupId, actorId: String(actorId) });
      await this._recordAudit(groupId, { actorId, action: "group.deleted" });
      return toPublicGroup(updated);
    });
  }

  /** Archive a group (owner/admin with EDIT_METADATA). Freezes membership mutations. */
  async archiveGroup({ groupId, actorId }) {
    return this._changeGroupState(groupId, actorId, GroupState.ARCHIVED, GroupEventType.GROUP_ARCHIVED, "archive");
  }

  /** Restore an archived group to active. */
  async restoreGroup({ groupId, actorId }) {
    return this._changeGroupState(groupId, actorId, GroupState.ACTIVE, GroupEventType.GROUP_RESTORED, "restore");
  }

  // === membership: invitations ==============================================

  /** Invite a member (requires INVITE_MEMBERS). Creates/renews an INVITED membership. */
  async inviteMember({ groupId, actorId, memberId, role }) {
    validateRef(groupId, "group identifier");
    validateRef(memberId, "member identifier");
    const desiredRole = role ? validateRole(role) : GroupRole.MEMBER;
    return this._withLock(groupId, async () => {
      const group = this._requireActive(await this.groups.findById(groupId), groupId);
      this._assertPermissionSync(group, await this._role(group, actorId), GroupPermission.INVITE_MEMBERS);
      const existing = await this.memberships.findByGroupAndMember(groupId, memberId);
      let membership;
      if (existing) {
        if (isActiveState(existing.state)) throw new DuplicateMembershipError("Member is already in the group", { details: { memberId } });
        if (existing.state === MembershipState.INVITED) throw new DuplicateInvitationError("An invitation is already pending", { details: { memberId } });
        if (existing.state === MembershipState.BANNED) throw new OwnershipError("Member is banned — unban before inviting", { code: "ERR_GROUP_INVALID_TRANSITION", status: 409, reason: "invalid-state-transition", details: { memberId } });
        const next = transitionMembership({ ...existing, role: desiredRole, invitedBy: String(actorId) }, MembershipState.INVITED, this._nowIso());
        membership = await this.memberships.update(existing.membershipId, { role: next.role, state: next.state, invitedBy: next.invitedBy, invitedAt: this._nowIso(), version: next.version, updatedAt: next.updatedAt });
      } else {
        const mem = createMembership({ groupId, memberId, role: desiredRole, state: MembershipState.INVITED, invitedBy: actorId, clock: this.clock, idGenerator: this.idGenerator });
        membership = await this.memberships.upsert(mem);
      }
      await this._applyVersion(group, VersionKind.MEMBERSHIP, { actorId, reason: "invite" });
      await this._recordMembership(groupId, { membership, action: "invited", toState: membership.state, toRole: membership.role, actorId });
      this.events.emit(GroupEventType.MEMBER_INVITED, { groupId: String(groupId), memberId: String(memberId), role: membership.role, invitedBy: String(actorId) });
      return toMembershipView(membership, group.permissionOverrides);
    });
  }

  /** Accept an invitation (the invitee acts on their own membership). INVITED → ACTIVE. */
  async acceptInvitation({ groupId, actorId, memberId }) {
    const subject = memberId ?? actorId;
    return this._selfTransition(groupId, actorId, subject, MembershipState.INVITED, MembershipState.ACTIVE, {
      event: GroupEventType.INVITATION_ACCEPTED,
      then: GroupEventType.MEMBER_JOINED,
      action: "invitation.accepted",
      enforceCapacity: true,
    });
  }

  /** Reject an invitation (the invitee declines). INVITED → LEFT. */
  async rejectInvitation({ groupId, actorId, memberId }) {
    const subject = memberId ?? actorId;
    return this._selfTransition(groupId, actorId, subject, MembershipState.INVITED, MembershipState.LEFT, {
      event: GroupEventType.INVITATION_REJECTED,
      action: "invitation.rejected",
    });
  }

  // === membership: join / leave =============================================

  /**
   * Join a group. A PUBLIC group joins directly (→ ACTIVE); otherwise a join REQUEST is created
   * (→ PENDING) awaiting approval. The caller acts on their own membership.
   */
  async joinGroup({ groupId, actorId, memberId }) {
    validateRef(groupId, "group identifier");
    const subject = String(memberId ?? actorId);
    if (String(actorId) !== subject) throw new PermissionDeniedError("A member may only join on their own behalf", { details: { actorId, memberId: subject } });
    return this._withLock(groupId, async () => {
      const group = this._requireActive(await this.groups.findById(groupId), groupId);
      const existing = await this.memberships.findByGroupAndMember(groupId, subject);
      if (existing && isActiveState(existing.state)) throw new DuplicateMembershipError("Already a member", { details: { memberId: subject } });
      if (existing && existing.state === MembershipState.BANNED) throw new PermissionDeniedError("Member is banned from this group", { details: { memberId: subject } });
      const open = group.metadata?.visibility === GroupVisibility.PUBLIC;
      const target = open ? MembershipState.ACTIVE : MembershipState.PENDING;
      if (open) await this._assertCapacity(groupId);
      let membership;
      if (existing) {
        const next = transitionMembership(existing, target, this._nowIso());
        membership = await this.memberships.update(existing.membershipId, { state: next.state, joinedAt: next.joinedAt, version: next.version, updatedAt: next.updatedAt });
      } else {
        const mem = createMembership({ groupId, memberId: subject, role: GroupRole.MEMBER, state: target, invitedBy: null, clock: this.clock, idGenerator: this.idGenerator });
        membership = await this.memberships.upsert(mem);
      }
      await this._applyVersion(group, VersionKind.MEMBERSHIP, { actorId, reason: open ? "join" : "join-request" });
      await this._recordMembership(groupId, { membership, action: open ? "joined" : "join-requested", toState: membership.state, actorId });
      this.events.emit(open ? GroupEventType.MEMBER_JOINED : GroupEventType.JOIN_REQUESTED, { groupId: String(groupId), memberId: subject });
      return toMembershipView(membership, group.permissionOverrides);
    });
  }

  /** Approve a pending join request (requires APPROVE_JOIN_REQUESTS). PENDING → ACTIVE. */
  async approveJoinRequest({ groupId, actorId, memberId }) {
    validateRef(groupId, "group identifier");
    validateRef(memberId, "member identifier");
    return this._withLock(groupId, async () => {
      const group = this._requireActive(await this.groups.findById(groupId), groupId);
      this._assertPermissionSync(group, await this._role(group, actorId), GroupPermission.APPROVE_JOIN_REQUESTS);
      const existing = requireMembership(await this.memberships.findByGroupAndMember(groupId, memberId), memberId);
      if (existing.state !== MembershipState.PENDING) throw new GroupError("No pending join request for this member", { code: "ERR_GROUP_INVALID_TRANSITION", status: 409, reason: "invalid-state-transition", details: { state: existing.state } });
      await this._assertCapacity(groupId);
      const next = transitionMembership(existing, MembershipState.ACTIVE, this._nowIso());
      const membership = await this.memberships.update(existing.membershipId, { state: next.state, joinedAt: next.joinedAt, version: next.version, updatedAt: next.updatedAt });
      await this._applyVersion(group, VersionKind.MEMBERSHIP, { actorId, reason: "approve-join" });
      await this._recordMembership(groupId, { membership, action: "join-approved", toState: membership.state, actorId });
      this.events.emit(GroupEventType.MEMBER_JOINED, { groupId: String(groupId), memberId: String(memberId), approvedBy: String(actorId) });
      return toMembershipView(membership, group.permissionOverrides);
    });
  }

  /** Leave a group (the member acts on their own membership). Owner must transfer first. */
  async leaveGroup({ groupId, actorId, memberId }) {
    validateRef(groupId, "group identifier");
    const subject = String(memberId ?? actorId);
    if (String(actorId) !== subject) throw new PermissionDeniedError("A member may only leave on their own behalf", { details: { actorId, memberId: subject } });
    return this._withLock(groupId, async () => {
      const group = requireGroup(await this.groups.findById(groupId), groupId);
      assertNotOwner(group, subject, "leave as");
      const existing = requireMembership(await this.memberships.findByGroupAndMember(groupId, subject), subject);
      const next = transitionMembership(existing, MembershipState.LEFT, this._nowIso());
      const membership = await this.memberships.update(existing.membershipId, { state: next.state, version: next.version, updatedAt: next.updatedAt });
      await this._applyVersion(group, VersionKind.MEMBERSHIP, { actorId, reason: "leave" });
      await this._recordMembership(groupId, { membership, action: "left", fromState: existing.state, toState: membership.state, actorId });
      this.events.emit(GroupEventType.MEMBER_LEFT, { groupId: String(groupId), memberId: subject });
      return toMembershipView(membership, group.permissionOverrides);
    });
  }

  /** Remove a member (requires REMOVE_MEMBERS + rank over the target). ACTIVE-ish → REMOVED. */
  async removeMember({ groupId, actorId, memberId }) {
    return this._adminTransition(groupId, actorId, memberId, MembershipState.REMOVED, {
      permission: GroupPermission.REMOVE_MEMBERS,
      event: GroupEventType.MEMBER_REMOVED,
      action: "removed",
    });
  }

  /** Ban a member (requires REMOVE_MEMBERS + rank). → BANNED (cannot rejoin until unbanned). */
  async banMember({ groupId, actorId, memberId }) {
    return this._adminTransition(groupId, actorId, memberId, MembershipState.BANNED, {
      permission: GroupPermission.REMOVE_MEMBERS,
      event: GroupEventType.MEMBER_BANNED,
      action: "banned",
    });
  }

  /** Mute a member (requires MUTE_MEMBERS + rank). ACTIVE → MUTED. */
  async muteMember({ groupId, actorId, memberId }) {
    return this._adminTransition(groupId, actorId, memberId, MembershipState.MUTED, {
      permission: GroupPermission.MUTE_MEMBERS,
      event: GroupEventType.MEMBER_MUTED,
      action: "muted",
    });
  }

  /** Unmute a member (requires MUTE_MEMBERS + rank). MUTED → ACTIVE. */
  async unmuteMember({ groupId, actorId, memberId }) {
    return this._adminTransition(groupId, actorId, memberId, MembershipState.ACTIVE, {
      permission: GroupPermission.MUTE_MEMBERS,
      event: GroupEventType.MEMBERSHIP_STATE_CHANGED,
      action: "unmuted",
    });
  }

  // === ownership + roles ====================================================

  /**
   * Transfer ownership to another member (owner only). The new owner must be an active member (or is
   * promoted from an existing membership); the outgoing owner becomes an administrator.
   */
  async transferOwnership({ groupId, actorId, newOwnerId }) {
    validateRef(groupId, "group identifier");
    return this._withLock(groupId, async () => {
      const group = this._requireActive(await this.groups.findById(groupId), groupId);
      if (String(group.ownerId) !== String(actorId)) throw new OwnershipError("Only the current owner may transfer ownership", { details: { groupId } });
      assertValidOwnershipTransfer(group, newOwnerId);
      const target = requireMembership(await this.memberships.findByGroupAndMember(groupId, newOwnerId), newOwnerId);
      if (!isActiveState(target.state)) throw new OwnershipError("New owner must be an active member", { details: { newOwnerId, state: target.state } });

      // Promote new owner, demote old owner to administrator.
      const newOwner = assignMembershipRole(target, GroupRole.OWNER, this._nowIso());
      await this.memberships.update(target.membershipId, { role: newOwner.role, version: newOwner.version, updatedAt: newOwner.updatedAt });
      const oldOwnerMem = await this.memberships.findByGroupAndMember(groupId, group.ownerId);
      if (oldOwnerMem) {
        const demoted = assignMembershipRole(oldOwnerMem, GroupRole.ADMINISTRATOR, this._nowIso());
        await this.memberships.update(oldOwnerMem.membershipId, { role: demoted.role, version: demoted.version, updatedAt: demoted.updatedAt });
      }
      const updated = await this._applyVersion(group, VersionKind.MEMBERSHIP, { actorId, reason: "transfer-ownership", patch: { ownerId: String(newOwnerId) } });
      await this._recordRole(groupId, { memberId: newOwnerId, fromRole: target.role, toRole: GroupRole.OWNER, actorId, action: "ownership-transferred" });
      this.events.emit(GroupEventType.OWNERSHIP_TRANSFERRED, { groupId: String(groupId), from: String(group.ownerId), to: String(newOwnerId) });
      await this._recordAudit(groupId, { actorId, action: "ownership.transferred", detail: { to: String(newOwnerId) } });
      return toPublicGroup(updated);
    });
  }

  /** Change a member's role (requires MANAGE_ROLES + rank rules). */
  async changeRole({ groupId, actorId, memberId, role }) {
    validateRef(groupId, "group identifier");
    validateRef(memberId, "member identifier");
    const desiredRole = validateRole(role);
    return this._withLock(groupId, async () => {
      const group = this._requireActive(await this.groups.findById(groupId), groupId);
      const actorRole = await this._role(group, actorId);
      this._assertPermissionSync(group, actorRole, GroupPermission.MANAGE_ROLES);
      assertNotOwner(group, memberId, "change the role of");
      const target = requireMembership(await this.memberships.findByGroupAndMember(groupId, memberId), memberId);
      if (!canAssignRole(actorRole, target.role, desiredRole)) {
        throw new PermissionDeniedError("Insufficient rank to assign this role", { details: { actorRole, targetRole: target.role, desiredRole } });
      }
      const next = assignMembershipRole(target, desiredRole, this._nowIso());
      if (next === target) return toMembershipView(target, group.permissionOverrides); // no-op
      const membership = await this.memberships.update(target.membershipId, { role: next.role, version: next.version, updatedAt: next.updatedAt });
      await this._applyVersion(group, VersionKind.ROLE, { actorId, reason: "role-change" });
      await this._recordRole(groupId, { memberId, fromRole: target.role, toRole: desiredRole, actorId, action: "role-changed" });
      this.events.emit(GroupEventType.ROLE_CHANGED, { groupId: String(groupId), memberId: String(memberId), from: target.role, to: desiredRole, actorId: String(actorId) });
      return toMembershipView(membership, group.permissionOverrides);
    });
  }

  // === metadata + permissions ===============================================

  /** Update group metadata (requires EDIT_METADATA). Optimistic `expectedVersion` guard. */
  async updateMetadata({ groupId, actorId, patch, expectedVersion }) {
    validateRef(groupId, "group identifier");
    if (patch) assertNoSecrets(patch, "metadata patch");
    return this._withLock(groupId, async () => {
      const group = this._requireActive(await this.groups.findById(groupId), groupId);
      this._assertPermissionSync(group, await this._role(group, actorId), GroupPermission.EDIT_METADATA);
      assertVersionMatch(expectedVersion, group.metadata?.version, VersionKind.METADATA);
      const now = this._nowIso();
      const { metadata, changed } = applyMetadataPatch(group.metadata, patch ?? {}, now);
      if (!changed.length) return toPublicGroup(group);
      const updated = await this._applyVersion(group, VersionKind.METADATA, { actorId, reason: "metadata", patch: { metadata, visibility: metadata.visibility } });
      await this.stores.metadataHistory?.record?.({ groupId: String(groupId), actorId: String(actorId), ...metadataHistoryEntry({ from: group.metadata, to: metadata, changed, actorId, at: now }) });
      this.events.emit(GroupEventType.METADATA_UPDATED, { groupId: String(groupId), changed, metadataVersion: metadata.version, actorId: String(actorId) });
      return toPublicGroup(updated);
    });
  }

  /** Replace/merge per-role permission overrides (requires MANAGE_PERMISSIONS — owner by default). */
  async updatePermissions({ groupId, actorId, overrides }) {
    validateRef(groupId, "group identifier");
    const validated = validatePermissionOverrides(overrides ?? {});
    return this._withLock(groupId, async () => {
      const group = this._requireActive(await this.groups.findById(groupId), groupId);
      this._assertPermissionSync(group, await this._role(group, actorId), GroupPermission.MANAGE_PERMISSIONS);
      const updated = await this._applyVersion(group, VersionKind.PERMISSION, { actorId, reason: "permissions", patch: { permissionOverrides: validated } });
      await this.stores.permissionHistory?.record?.({ groupId: String(groupId), actorId: String(actorId), action: "permission-changed", detail: { overrides: validated } });
      this.events.emit(GroupEventType.PERMISSION_CHANGED, { groupId: String(groupId), actorId: String(actorId) });
      return toPermissionView(updated);
    });
  }

  // === reads ================================================================

  /** The public group DTO (with live member count). */
  async getGroup({ groupId }) {
    const group = requireGroup(await this.groups.findById(groupId), groupId);
    return toPublicGroup(group, { memberCount: await this._countActive(groupId) });
  }

  /** Full group details (group + members + roles + permissions). */
  async getGroupDetails({ groupId, actorId }) {
    const group = requireGroup(await this.groups.findById(groupId), groupId);
    if (actorId) this._assertPermissionSync(group, await this._role(group, actorId), GroupPermission.VIEW_GROUP);
    const memberships = await this.memberships.listByGroup(groupId);
    return toGroupDetails(group, memberships);
  }

  /** List a group's members (optionally filtered by state; requires VIEW_MEMBERS if actor given). */
  async listMembers({ groupId, actorId, states, limit, offset } = {}) {
    const group = requireGroup(await this.groups.findById(groupId), groupId);
    if (actorId) this._assertPermissionSync(group, await this._role(group, actorId), GroupPermission.VIEW_MEMBERS);
    const page = normalizePagination({ limit, offset });
    const all = await this.memberships.listByGroup(groupId, { states });
    const slice = all.slice(page.offset, page.offset + page.limit);
    return { total: all.length, limit: page.limit, offset: page.offset, members: toMemberList(slice, group.permissionOverrides) };
  }

  /** The groups a member belongs to (active memberships by default). */
  async listMyGroups({ memberId, states = ACTIVE_MEMBERSHIP_STATES }) {
    validateRef(memberId, "member identifier");
    const memberships = await this.memberships.listByMember(memberId, { states });
    const out = [];
    for (const m of memberships) {
      const group = await this.groups.findById(m.groupId);
      if (group && group.state !== GroupState.DELETED) out.push({ ...toPublicGroup(group, { memberCount: await this._countActive(m.groupId) }), myRole: m.role, myState: m.state });
    }
    return out;
  }

  /** The role hierarchy + effective permission matrix for a group. */
  async getRoles({ groupId }) {
    const group = requireGroup(await this.groups.findById(groupId), groupId);
    return toRoleView(group);
  }

  /** The effective permission matrix + overrides for a group. */
  async getPermissions({ groupId }) {
    const group = requireGroup(await this.groups.findById(groupId), groupId);
    return toPermissionView(group);
  }

  /** The group's version vector. */
  async getVersions({ groupId }) {
    const group = requireGroup(await this.groups.findById(groupId), groupId);
    return toVersionView(group);
  }

  /** The group's replica snapshot (rebuilds + persists if requested). */
  async getReplicaState({ groupId, refresh = false }) {
    const group = requireGroup(await this.groups.findById(groupId), groupId);
    if (refresh) return toReplicaView(await this._refreshReplica(group));
    const stored = await this.replicaStates?.findByGroup?.(groupId);
    return toReplicaView(stored ?? (await this._refreshReplica(group)));
  }

  /** Rebuild the replica snapshot + report drift vs. the stored one. */
  async refreshReplicaState({ groupId }) {
    const group = requireGroup(await this.groups.findById(groupId), groupId);
    const stored = await this.replicaStates?.findByGroup?.(groupId);
    const fresh = await this._refreshReplica(group);
    return { replica: toReplicaView(fresh), diff: diffReplica(stored, fresh) };
  }

  // === history + diagnostics ================================================

  async getVersionHistory({ groupId, limit }) {
    validateRef(groupId, "group identifier");
    return (await this.stores.versionHistory?.listByGroup?.(groupId, { limit })) ?? [];
  }
  async getMetadataHistory({ groupId, limit }) {
    validateRef(groupId, "group identifier");
    return (await this.stores.metadataHistory?.listByGroup?.(groupId, { limit })) ?? [];
  }
  async getMembershipHistory({ groupId, limit }) {
    validateRef(groupId, "group identifier");
    return (await this.stores.membershipHistory?.listByGroup?.(groupId, { limit })) ?? [];
  }
  async getAuditTrail({ groupId, limit }) {
    validateRef(groupId, "group identifier");
    return (await this.stores.audit?.listByGroup?.(groupId, { limit })) ?? [];
  }

  /** Aggregate control-plane health. */
  async health() {
    return { framework: GROUP_FRAMEWORK, schemaVersion: GROUP_SCHEMA_VERSION, maxMembers: this.maxMembers, at: this._nowIso() };
  }

  // === internals ============================================================

  /** @private the effective role of an actor in a group (owner shortcut → owner role). */
  async _role(group, actorId) {
    if (!actorId) throw new PermissionDeniedError("Missing actor", { details: { groupId: group?.groupId } });
    if (String(group.ownerId) === String(actorId)) return GroupRole.OWNER;
    const membership = await this.memberships.findByGroupAndMember(group.groupId, actorId);
    if (!membership || !isActiveState(membership.state)) {
      throw new PermissionDeniedError("Actor is not an active member of this group", { details: { groupId: group?.groupId, actorId } });
    }
    return membership.role;
  }

  /** @private assert a role holds a permission under the group's overrides. */
  _assertPermissionSync(group, actorRole, permission) {
    if (!hasPermission(actorRole, permission, group.permissionOverrides ?? {})) {
      throw new PermissionDeniedError(`Role "${actorRole}" lacks permission "${permission}"`, { details: { groupId: group.groupId, actorRole, permission } });
    }
    return true;
  }

  /** @private require a group to exist AND be active. */
  _requireActive(group, ref) {
    requireGroup(group, ref);
    assertGroupActive(group);
    return group;
  }

  /** @private bump a facet version (+ aggregate), persist the group with an optional patch, audit + emit. */
  async _applyVersion(group, kind, { actorId, reason, patch = {} } = {}) {
    const before = { ...(group.versions ?? {}) };
    const versions = bumpVersion(group.versions, kind);
    const updated = await this.groups.update(group.groupId, { ...patch, versions });
    await this.stores.versionHistory?.record?.({ groupId: String(group.groupId), actorId: actorId != null ? String(actorId) : null, ...versionHistoryEntry({ kind: VersionKind.GROUP, from: before.group ?? 1, to: versions.group, actorId, reason }) });
    this.events.emit(GroupEventType.GROUP_VERSION_UPDATED, { groupId: String(group.groupId), kind, versions });
    await this._refreshReplica(updated);
    return updated;
  }

  /** @private rebuild + persist the replica snapshot; emit REPLICA_UPDATED. */
  async _refreshReplica(group) {
    const memberships = await this.memberships.listByGroup(group.groupId);
    const snapshot = buildReplicaState({ group, memberships, clock: this.clock, idGenerator: this.idGenerator });
    const stored = await this.replicaStates?.upsert?.(snapshot);
    this.events.emit(GroupEventType.REPLICA_UPDATED, { groupId: String(group.groupId), replicaVersion: snapshot.replicaVersion, fingerprint: snapshot.syncMetadata.fingerprint });
    return stored ?? snapshot;
  }

  /** @private shared self-service transition (accept/reject) where the actor owns the membership. */
  async _selfTransition(groupId, actorId, subject, fromState, toState, { event, then, action, enforceCapacity } = {}) {
    validateRef(groupId, "group identifier");
    validateRef(subject, "member identifier");
    if (String(actorId) !== String(subject)) throw new PermissionDeniedError("This action may only be performed on your own membership", { details: { actorId, memberId: subject } });
    return this._withLock(groupId, async () => {
      const group = this._requireActive(await this.groups.findById(groupId), groupId);
      const existing = requireMembership(await this.memberships.findByGroupAndMember(groupId, subject), subject);
      if (existing.state !== fromState) throw new GroupError(`Membership is "${existing.state}", not "${fromState}"`, { code: "ERR_GROUP_INVALID_TRANSITION", status: 409, reason: "invalid-state-transition", details: { state: existing.state } });
      if (enforceCapacity && toState === MembershipState.ACTIVE) await this._assertCapacity(groupId);
      const next = transitionMembership(existing, toState, this._nowIso());
      const membership = await this.memberships.update(existing.membershipId, { state: next.state, joinedAt: next.joinedAt, version: next.version, updatedAt: next.updatedAt });
      await this._applyVersion(group, VersionKind.MEMBERSHIP, { actorId, reason: action });
      await this._recordMembership(groupId, { membership, action, fromState, toState, actorId });
      this.events.emit(event, { groupId: String(groupId), memberId: String(subject) });
      if (then) this.events.emit(then, { groupId: String(groupId), memberId: String(subject) });
      return toMembershipView(membership, group.permissionOverrides);
    });
  }

  /** @private shared admin transition (remove/ban/mute/unmute) with permission + rank checks. */
  async _adminTransition(groupId, actorId, memberId, toState, { permission, event, action } = {}) {
    validateRef(groupId, "group identifier");
    validateRef(memberId, "member identifier");
    return this._withLock(groupId, async () => {
      const group = this._requireActive(await this.groups.findById(groupId), groupId);
      const actorRole = await this._role(group, actorId);
      this._assertPermissionSync(group, actorRole, permission);
      assertNotOwner(group, memberId, `${action} the owner —`);
      const target = requireMembership(await this.memberships.findByGroupAndMember(groupId, memberId), memberId);
      if (!canManageMember(actorRole, target.role)) throw new PermissionDeniedError("Insufficient rank to manage this member", { details: { actorRole, targetRole: target.role } });
      const next = transitionMembership(target, toState, this._nowIso());
      const membership = await this.memberships.update(target.membershipId, { state: next.state, version: next.version, updatedAt: next.updatedAt });
      await this._applyVersion(group, VersionKind.MEMBERSHIP, { actorId, reason: action });
      await this._recordMembership(groupId, { membership, action, fromState: target.state, toState, actorId });
      this.events.emit(event, { groupId: String(groupId), memberId: String(memberId), actorId: String(actorId) });
      return toMembershipView(membership, group.permissionOverrides);
    });
  }

  /** @private change the group entity's lifecycle state (archive/restore) with EDIT_METADATA. */
  async _changeGroupState(groupId, actorId, toState, event, reason) {
    validateRef(groupId, "group identifier");
    return this._withLock(groupId, async () => {
      const group = requireGroup(await this.groups.findById(groupId), groupId);
      this._assertPermissionSync(group, await this._role(group, actorId), GroupPermission.EDIT_METADATA);
      assertGroupTransition(group.state, toState);
      const updated = await this._applyVersion(group, VersionKind.GROUP, { actorId, reason, patch: { state: toState } });
      this.events.emit(event, { groupId: String(groupId), actorId: String(actorId) });
      await this._recordAudit(groupId, { actorId, action: `group.${reason}` });
      return toPublicGroup(updated);
    });
  }

  /** @private enforce the group member cap on becoming active. */
  async _assertCapacity(groupId) {
    const count = await this._countActive(groupId);
    if (count >= this.maxMembers) throw new GroupStateError(`Group is at capacity (${this.maxMembers})`, { code: "ERR_GROUP_VALIDATION", status: 409, reason: "limit-exceeded", details: { max: this.maxMembers } });
  }

  /** @private count members in a counted state. */
  async _countActive(groupId) {
    return this.memberships.countByGroup(groupId, { states: ACTIVE_MEMBERSHIP_STATES });
  }

  async _recordMembership(groupId, entry) {
    return this.stores.membershipHistory?.record?.({ groupId: String(groupId), memberId: entry.membership?.memberId, actorId: entry.actorId != null ? String(entry.actorId) : null, ...membershipHistoryEntry(entry) });
  }
  async _recordRole(groupId, entry) {
    return this.stores.roleHistory?.record?.({ groupId: String(groupId), memberId: String(entry.memberId), actorId: String(entry.actorId), action: entry.action, detail: { fromRole: entry.fromRole, toRole: entry.toRole } });
  }
  async _recordAudit(groupId, entry) {
    return this.stores.audit?.record?.({ groupId: String(groupId), actorId: entry.actorId != null ? String(entry.actorId) : null, action: entry.action, detail: entry.detail ?? {} });
  }

  /** @private serialize mutating work per group so concurrent updates never interleave. */
  async _withLock(groupId, fn) {
    const key = String(groupId);
    const prev = this._locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((r) => (release = r));
    // The chain's tail is this call's gate; the next caller awaits it before starting.
    const tail = prev.then(() => gate);
    this._locks.set(key, tail);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      // Only clear the map if no later caller has chained on after us.
      if (this._locks.get(key) === tail) this._locks.delete(key);
    }
  }

  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}

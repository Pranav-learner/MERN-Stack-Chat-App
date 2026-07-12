/**
 * @module group/serializers
 *
 * Public DTOs for the Group Foundation subsystem. Whitelists PUBLIC fields for groups, group details,
 * memberships, member lists, roles, permissions, versions, replicas, and audit entries. Every view
 * carries control-plane data (ids, roles, states, versions, counts, metadata) ONLY — never keys or
 * message content. Keeping serialization in one place means the API surface can't accidentally leak an
 * internal field.
 */

import { resolvePermissions, permissionMatrix } from "../permissions/permissions.js";
import { roleHierarchy } from "../roles/roles.js";
import { isActiveState } from "../lifecycle/lifecycle.js";

/** A group's public DTO (identity + metadata + versions + counts). */
export function toPublicGroup(group, { memberCount } = {}) {
  if (!group) return null;
  return {
    groupId: group.groupId,
    ownerId: group.ownerId,
    state: group.state,
    visibility: group.metadata?.visibility ?? group.visibility,
    metadata: toMetadataView(group.metadata),
    versions: { ...group.versions },
    memberCount: memberCount ?? group.memberCount,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    schemaVersion: group.schemaVersion,
  };
}

/** The metadata facet DTO. */
export function toMetadataView(metadata) {
  if (!metadata) return null;
  return {
    name: metadata.name,
    description: metadata.description ?? "",
    avatar: metadata.avatar ?? null,
    tags: metadata.tags ?? [],
    visibility: metadata.visibility,
    announcement: !!metadata.announcement,
    custom: metadata.custom ?? {},
    version: metadata.version,
    updatedAt: metadata.updatedAt,
  };
}

/** Full group details (group + members + effective permissions + role hierarchy). */
export function toGroupDetails(group, memberships = []) {
  const members = memberships.map(toMembershipView);
  const counted = members.filter((m) => isActiveState(m.state));
  return {
    group: toPublicGroup(group, { memberCount: counted.length }),
    members,
    memberCount: counted.length,
    totalMemberships: members.length,
    roles: roleHierarchy(),
    permissions: permissionMatrix(group.permissionOverrides ?? {}),
    permissionOverrides: group.permissionOverrides ?? {},
  };
}

/** A single membership DTO (its effective permissions folded in). */
export function toMembershipView(membership, overrides = {}) {
  if (!membership) return null;
  return {
    membershipId: membership.membershipId,
    groupId: membership.groupId,
    memberId: membership.memberId,
    role: membership.role,
    state: membership.state,
    counted: isActiveState(membership.state),
    invitedBy: membership.invitedBy ?? null,
    invitedAt: membership.invitedAt,
    joinedAt: membership.joinedAt ?? null,
    permissions: resolvePermissions(membership.role, overrides),
    metadata: membership.metadata ?? {},
    version: membership.version,
    updatedAt: membership.updatedAt,
  };
}

/** A member-list DTO (compact rows). */
export function toMemberList(memberships = [], overrides = {}) {
  return memberships.map((m) => ({
    memberId: m.memberId,
    role: m.role,
    state: m.state,
    counted: isActiveState(m.state),
    joinedAt: m.joinedAt ?? null,
    version: m.version,
    permissions: resolvePermissions(m.role, overrides),
  }));
}

/** The role-hierarchy DTO. */
export function toRoleView(group) {
  return {
    roles: roleHierarchy(),
    permissions: permissionMatrix(group?.permissionOverrides ?? {}),
  };
}

/** The permission-matrix DTO. */
export function toPermissionView(group) {
  return {
    matrix: permissionMatrix(group?.permissionOverrides ?? {}),
    overrides: group?.permissionOverrides ?? {},
  };
}

/** The version-vector DTO. */
export function toVersionView(group) {
  return { groupId: group?.groupId, versions: { ...(group?.versions ?? {}) }, updatedAt: group?.updatedAt };
}

/** A replica-state DTO (counts + fingerprint; never member content beyond ids). */
export function toReplicaView(snapshot) {
  if (!snapshot) return null;
  return {
    replicaId: snapshot.replicaId,
    groupId: snapshot.groupId,
    replicaVersion: snapshot.replicaVersion,
    versions: { ...(snapshot.versions ?? {}) },
    membershipSnapshot: snapshot.membershipSnapshot,
    metadataSnapshot: toMetadataView(snapshot.metadataSnapshot),
    pendingUpdates: snapshot.pendingUpdates ?? [],
    syncMetadata: snapshot.syncMetadata,
    diagnostics: snapshot.diagnostics,
    updatedAt: snapshot.updatedAt,
  };
}

/** An audit-trail entry DTO. */
export function toAuditEntry(entry) {
  return { ...entry };
}

/**
 * @module group
 *
 * **Layer 10 · Sprint 1 — Group Foundation & Membership Management.** Establishes a Group as a
 * FIRST-CLASS DISTRIBUTED ENTITY with its own identity, lifecycle, membership, roles, permissions,
 * versioned metadata, a per-facet version vector, and a reconcilable replica snapshot. It is the
 * control-plane FOUNDATION for future secure group messaging.
 *
 * @security Reasons over ids + roles + states + versions + non-secret metadata ONLY — never message
 * plaintext, ciphertext, or key material. Group encryption keys are derived in a later sprint and never
 * stored here.
 *
 * @evolution Transport-, encryption-, networking-, and synchronization-implementation-INDEPENDENT.
 * Sprint 2 (secure group messaging + group key management + encrypted fan-out + group synchronization)
 * CONSUMES this subsystem's entities + events; it does not modify them. Versioning + the replica
 * snapshot are the seams a future Layer-9 group-replication hybrid drops onto.
 *
 * @example
 * ```js
 * import { GroupManager, createInMemoryGroupRepository, createGroupApi } from "./group/index.js";
 * const mgr = new GroupManager({ ...createInMemoryGroupRepository() });
 * const api = createGroupApi(mgr);
 * const group = await api.createGroup({ ownerId: "alice", metadata: { name: "Design" } });
 * await api.inviteMember({ groupId: group.groupId, actorId: "alice", memberId: "bob" });
 * await api.acceptInvitation({ groupId: group.groupId, actorId: "bob", memberId: "bob" });
 * ```
 */

// Types + errors + events
export * from "./types/types.js";
export * from "./errors.js";
export { GroupEventBus } from "./events/events.js";

// Versions
export { createVersionVector, normalizeVersionVector, bumpVersion, compareVersionVectors, assertVersionMatch, versionHistoryEntry } from "./versions/versionManager.js";

// Roles + permissions
export { validateRole, roleRank, isRoleAtLeast, outranks, canAssignRole, canManageMember, assignableRoles, roleHierarchy } from "./roles/roles.js";
export { OWNER_ONLY_PERMISSIONS, validatePermission, validatePermissionOverrides, defaultPermissionsForRole, resolvePermissions, hasPermission, permissionMatrix } from "./permissions/permissions.js";

// Lifecycle + metadata
export { canTransition, assertTransition, nextStatesOf, isTerminalState, isActiveState, isPendingState, canTransitionGroup, assertGroupTransition, assertGroupActive } from "./lifecycle/lifecycle.js";
export { METADATA_FIELDS, validateName, validateVisibility, createMetadata, applyMetadataPatch, metadataHistoryEntry } from "./metadata/metadata.js";

// Membership + replicas
export { createMembership, transitionMembership, assignMembershipRole, membershipHistoryEntry } from "./membership/membership.js";
export { buildReplicaState, diffReplica, projectMembership, replicaFingerprint, toReplicationEntities } from "./replicas/replicaState.js";

// Validators + serializers + dto
export * from "./validators/validators.js";
export { toPublicGroup, toGroupDetails, toMembershipView, toMemberList, toRoleView, toPermissionView, toVersionView, toReplicaView, toMetadataView } from "./serializers/serializers.js";
export * from "./dto/dto.js";

// Repositories
export { createInMemoryGroupRepository } from "./repository/inMemoryGroupRepository.js";
export { createMongoGroupRepository } from "./repository/mongoGroupRepository.js";

// Manager + API
export { GroupManager } from "./manager/groupManager.js";
export { createGroupApi } from "./api/groupApi.js";

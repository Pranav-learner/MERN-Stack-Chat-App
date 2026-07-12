/**
 * @module group/api
 *
 * The stable **group service facade** the HTTP controller delegates to. Wraps the {@link GroupManager}
 * with a flat, DTO-normalizing surface: create/delete/archive/restore group, invite/accept/reject,
 * join/approve, leave/remove/ban/mute, transfer ownership, change role, update metadata + permissions,
 * and read members / roles / permissions / details / versions / replica / history.
 *
 * Every entry point runs its input through {@link module:group/dto} normalizers, so the controller
 * passes request bodies straight through and this facade guarantees the manager receives exactly-shaped
 * params.
 *
 * @security Every mutating op is permission- + rank-checked in the manager; reads return control-plane
 * metadata + counts only (no keys / message content).
 */

import {
  normalizeCreateGroup,
  normalizeInvite,
  normalizeMemberTarget,
  normalizeTransferOwnership,
  normalizeMetadataUpdate,
  normalizeRoleChange,
  normalizePermissionChange,
} from "../dto/dto.js";

export function createGroupApi(manager) {
  return {
    // group lifecycle
    createGroup: (params) => manager.createGroup(normalizeCreateGroup(params)),
    deleteGroup: (params) => manager.deleteGroup(normalizeMemberTarget(params)),
    archiveGroup: (params) => manager.archiveGroup(normalizeMemberTarget(params)),
    restoreGroup: (params) => manager.restoreGroup(normalizeMemberTarget(params)),

    // invitations
    inviteMember: (params) => manager.inviteMember(normalizeInvite(params)),
    acceptInvitation: (params) => manager.acceptInvitation(normalizeMemberTarget(params)),
    rejectInvitation: (params) => manager.rejectInvitation(normalizeMemberTarget(params)),

    // join / leave
    joinGroup: (params) => manager.joinGroup(normalizeMemberTarget(params)),
    approveJoinRequest: (params) => manager.approveJoinRequest(normalizeMemberTarget(params)),
    leaveGroup: (params) => manager.leaveGroup(normalizeMemberTarget(params)),
    removeMember: (params) => manager.removeMember(normalizeMemberTarget(params)),
    banMember: (params) => manager.banMember(normalizeMemberTarget(params)),
    muteMember: (params) => manager.muteMember(normalizeMemberTarget(params)),
    unmuteMember: (params) => manager.unmuteMember(normalizeMemberTarget(params)),

    // ownership + roles
    transferOwnership: (params) => manager.transferOwnership(normalizeTransferOwnership(params)),
    changeRole: (params) => manager.changeRole(normalizeRoleChange(params)),

    // metadata + permissions
    updateMetadata: (params) => manager.updateMetadata(normalizeMetadataUpdate(params)),
    updatePermissions: (params) => manager.updatePermissions(normalizePermissionChange(params)),

    // reads
    getGroup: (params) => manager.getGroup(params),
    getGroupDetails: (params) => manager.getGroupDetails(params),
    listMembers: (params) => manager.listMembers(params),
    listMyGroups: (params) => manager.listMyGroups(params),
    getRoles: (params) => manager.getRoles(params),
    getPermissions: (params) => manager.getPermissions(params),
    getVersions: (params) => manager.getVersions(params),
    getReplicaState: (params) => manager.getReplicaState(params),
    refreshReplicaState: (params) => manager.refreshReplicaState(params),

    // history + diagnostics
    getVersionHistory: (params) => manager.getVersionHistory(params),
    getMetadataHistory: (params) => manager.getMetadataHistory(params),
    getMembershipHistory: (params) => manager.getMembershipHistory(params),
    getAuditTrail: (params) => manager.getAuditTrail(params),
    health: () => manager.health(),
  };
}

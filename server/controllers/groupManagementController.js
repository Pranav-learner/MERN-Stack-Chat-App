/**
 * @module controllers/groupManagementController
 *
 * HTTP handlers for the **Group Foundation & Membership Management** subsystem (Layer 10, Sprint 1),
 * mounted at `/api/group-management`. A Group is a first-class distributed entity: this surface creates
 * groups, manages membership (invite/accept/reject, join/approve, leave/remove/ban/mute), transfers
 * ownership, changes roles, updates versioned metadata + permissions, and reads members / roles /
 * permissions / details / versions / replica state / history.
 *
 * Every route is JWT-protected; `req.user._id` is the ACTING caller. The manager permission- + rank-
 * checks each mutation, so a handler simply forwards `actorId = caller` plus the request body.
 *
 * @note This is additive and independent of the existing Layer 1 `/api/groups` chat-group routes. It
 * reasons over control-plane metadata ONLY — never message plaintext, ciphertext, or keys. Group
 * messaging / encryption / fan-out are a later sprint that consumes this subsystem.
 */

import { GroupManager } from "../group/manager/groupManager.js";
import { createGroupApi } from "../group/api/groupApi.js";
import { createMongoGroupRepository } from "../group/repository/mongoGroupRepository.js";
import { GroupEventBus } from "../group/events/events.js";
import { GroupError } from "../group/errors.js";

/** Shared group control-plane event bus. A future Layer 10 Sprint 2 subscribes here. */
export const groupEvents = new GroupEventBus();

/** Process-wide Group Manager over the Mongo-backed repository. */
export const groupManager = new GroupManager({ ...createMongoGroupRepository(), events: groupEvents });

/** The stable facade the HTTP handlers delegate to. */
export const groupApi = createGroupApi(groupManager);

const callerId = (req) => String(req.user._id);
const groupId = (req) => req.params.groupId;

function handleError(res, error, where) {
  if (error instanceof GroupError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, reason: error.reason, details: error.details });
  }
  console.log(`Error in ${where}`, error?.message);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
}

// === group lifecycle ========================================================

/** POST /groups — create a group (caller becomes owner). Body: { metadata, permissionOverrides?, initialMembers? }. */
export const createGroup = async (req, res) => {
  try {
    const group = await groupApi.createGroup({ ownerId: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, group });
  } catch (error) {
    return handleError(res, error, "createGroup");
  }
};

/** DELETE /groups/:groupId — soft-delete a group (owner only). */
export const deleteGroup = async (req, res) => {
  try {
    const group = await groupApi.deleteGroup({ groupId: groupId(req), actorId: callerId(req) });
    return res.status(200).json({ success: true, group });
  } catch (error) {
    return handleError(res, error, "deleteGroup");
  }
};

/** POST /groups/:groupId/archive — archive a group. */
export const archiveGroup = async (req, res) => {
  try {
    const group = await groupApi.archiveGroup({ groupId: groupId(req), actorId: callerId(req) });
    return res.status(200).json({ success: true, group });
  } catch (error) {
    return handleError(res, error, "archiveGroup");
  }
};

/** POST /groups/:groupId/restore — restore an archived group. */
export const restoreGroup = async (req, res) => {
  try {
    const group = await groupApi.restoreGroup({ groupId: groupId(req), actorId: callerId(req) });
    return res.status(200).json({ success: true, group });
  } catch (error) {
    return handleError(res, error, "restoreGroup");
  }
};

// === invitations ============================================================

/** POST /groups/:groupId/invite — invite a member. Body: { memberId, role? }. */
export const inviteMember = async (req, res) => {
  try {
    const membership = await groupApi.inviteMember({ groupId: groupId(req), actorId: callerId(req), ...(req.body ?? {}) });
    return res.status(201).json({ success: true, membership });
  } catch (error) {
    return handleError(res, error, "inviteMember");
  }
};

/** POST /groups/:groupId/accept — accept an invitation (self). */
export const acceptInvitation = async (req, res) => {
  try {
    const membership = await groupApi.acceptInvitation({ groupId: groupId(req), actorId: callerId(req), memberId: callerId(req) });
    return res.status(200).json({ success: true, membership });
  } catch (error) {
    return handleError(res, error, "acceptInvitation");
  }
};

/** POST /groups/:groupId/reject — reject an invitation (self). */
export const rejectInvitation = async (req, res) => {
  try {
    const membership = await groupApi.rejectInvitation({ groupId: groupId(req), actorId: callerId(req), memberId: callerId(req) });
    return res.status(200).json({ success: true, membership });
  } catch (error) {
    return handleError(res, error, "rejectInvitation");
  }
};

// === join / leave ===========================================================

/** POST /groups/:groupId/join — join a group (self). Public → active; else → pending. */
export const joinGroup = async (req, res) => {
  try {
    const membership = await groupApi.joinGroup({ groupId: groupId(req), actorId: callerId(req), memberId: callerId(req) });
    return res.status(200).json({ success: true, membership });
  } catch (error) {
    return handleError(res, error, "joinGroup");
  }
};

/** POST /groups/:groupId/approve — approve a pending join request. Body: { memberId }. */
export const approveJoinRequest = async (req, res) => {
  try {
    const membership = await groupApi.approveJoinRequest({ groupId: groupId(req), actorId: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, membership });
  } catch (error) {
    return handleError(res, error, "approveJoinRequest");
  }
};

/** POST /groups/:groupId/leave — leave a group (self). */
export const leaveGroup = async (req, res) => {
  try {
    const membership = await groupApi.leaveGroup({ groupId: groupId(req), actorId: callerId(req), memberId: callerId(req) });
    return res.status(200).json({ success: true, membership });
  } catch (error) {
    return handleError(res, error, "leaveGroup");
  }
};

/** POST /groups/:groupId/remove — remove a member. Body: { memberId }. */
export const removeMember = async (req, res) => {
  try {
    const membership = await groupApi.removeMember({ groupId: groupId(req), actorId: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, membership });
  } catch (error) {
    return handleError(res, error, "removeMember");
  }
};

/** POST /groups/:groupId/ban — ban a member. Body: { memberId }. */
export const banMember = async (req, res) => {
  try {
    const membership = await groupApi.banMember({ groupId: groupId(req), actorId: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, membership });
  } catch (error) {
    return handleError(res, error, "banMember");
  }
};

/** POST /groups/:groupId/mute — mute a member. Body: { memberId }. */
export const muteMember = async (req, res) => {
  try {
    const membership = await groupApi.muteMember({ groupId: groupId(req), actorId: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, membership });
  } catch (error) {
    return handleError(res, error, "muteMember");
  }
};

/** POST /groups/:groupId/unmute — unmute a member. Body: { memberId }. */
export const unmuteMember = async (req, res) => {
  try {
    const membership = await groupApi.unmuteMember({ groupId: groupId(req), actorId: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, membership });
  } catch (error) {
    return handleError(res, error, "unmuteMember");
  }
};

// === ownership + roles ======================================================

/** POST /groups/:groupId/transfer-ownership — transfer ownership. Body: { newOwnerId }. */
export const transferOwnership = async (req, res) => {
  try {
    const group = await groupApi.transferOwnership({ groupId: groupId(req), actorId: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, group });
  } catch (error) {
    return handleError(res, error, "transferOwnership");
  }
};

/** POST /groups/:groupId/roles — change a member's role. Body: { memberId, role }. */
export const changeRole = async (req, res) => {
  try {
    const membership = await groupApi.changeRole({ groupId: groupId(req), actorId: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, membership });
  } catch (error) {
    return handleError(res, error, "changeRole");
  }
};

// === metadata + permissions =================================================

/** PATCH /groups/:groupId/metadata — update metadata. Body: { patch | fields, expectedVersion? }. */
export const updateMetadata = async (req, res) => {
  try {
    const group = await groupApi.updateMetadata({ groupId: groupId(req), actorId: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, group });
  } catch (error) {
    return handleError(res, error, "updateMetadata");
  }
};

/** PUT /groups/:groupId/permissions — set per-role permission overrides. Body: { overrides }. */
export const updatePermissions = async (req, res) => {
  try {
    const permissions = await groupApi.updatePermissions({ groupId: groupId(req), actorId: callerId(req), ...(req.body ?? {}) });
    return res.status(200).json({ success: true, permissions });
  } catch (error) {
    return handleError(res, error, "updatePermissions");
  }
};

// === reads ==================================================================

/** GET /groups/mine — the caller's groups. */
export const listMyGroups = async (req, res) => {
  try {
    const groups = await groupApi.listMyGroups({ memberId: callerId(req) });
    return res.status(200).json({ success: true, groups });
  } catch (error) {
    return handleError(res, error, "listMyGroups");
  }
};

/** GET /groups/:groupId — the public group DTO. */
export const getGroup = async (req, res) => {
  try {
    const group = await groupApi.getGroup({ groupId: groupId(req) });
    return res.status(200).json({ success: true, group });
  } catch (error) {
    return handleError(res, error, "getGroup");
  }
};

/** GET /groups/:groupId/details — full group details (members + roles + permissions). */
export const getGroupDetails = async (req, res) => {
  try {
    const details = await groupApi.getGroupDetails({ groupId: groupId(req), actorId: callerId(req) });
    return res.status(200).json({ success: true, details });
  } catch (error) {
    return handleError(res, error, "getGroupDetails");
  }
};

/** GET /groups/:groupId/members — list members (?states=&limit=&offset=). */
export const listMembers = async (req, res) => {
  try {
    const states = req.query.states ? String(req.query.states).split(",") : undefined;
    const result = await groupApi.listMembers({ groupId: groupId(req), actorId: callerId(req), states, limit: req.query.limit ? Number(req.query.limit) : undefined, offset: req.query.offset ? Number(req.query.offset) : undefined });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "listMembers");
  }
};

/** GET /groups/:groupId/roles — role hierarchy + permission matrix. */
export const getRoles = async (req, res) => {
  try {
    const roles = await groupApi.getRoles({ groupId: groupId(req) });
    return res.status(200).json({ success: true, roles });
  } catch (error) {
    return handleError(res, error, "getRoles");
  }
};

/** GET /groups/:groupId/permissions — effective permission matrix + overrides. */
export const getPermissions = async (req, res) => {
  try {
    const permissions = await groupApi.getPermissions({ groupId: groupId(req) });
    return res.status(200).json({ success: true, permissions });
  } catch (error) {
    return handleError(res, error, "getPermissions");
  }
};

/** GET /groups/:groupId/versions — the group's version vector. */
export const getVersions = async (req, res) => {
  try {
    const versions = await groupApi.getVersions({ groupId: groupId(req) });
    return res.status(200).json({ success: true, versions });
  } catch (error) {
    return handleError(res, error, "getVersions");
  }
};

/** GET /groups/:groupId/replica — the group's replica snapshot (?refresh=1). */
export const getReplicaState = async (req, res) => {
  try {
    const replica = await groupApi.getReplicaState({ groupId: groupId(req), refresh: req.query.refresh === "1" || req.query.refresh === "true" });
    return res.status(200).json({ success: true, replica });
  } catch (error) {
    return handleError(res, error, "getReplicaState");
  }
};

/** POST /groups/:groupId/replica/refresh — rebuild the replica snapshot + report drift. */
export const refreshReplicaState = async (req, res) => {
  try {
    const result = await groupApi.refreshReplicaState({ groupId: groupId(req) });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "refreshReplicaState");
  }
};

// === history + diagnostics ==================================================

/** GET /groups/:groupId/history/:kind — version|metadata|membership|audit history (?limit=). */
export const getHistory = async (req, res) => {
  try {
    const kind = req.params.kind;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const map = {
      versions: () => groupApi.getVersionHistory({ groupId: groupId(req), limit }),
      metadata: () => groupApi.getMetadataHistory({ groupId: groupId(req), limit }),
      membership: () => groupApi.getMembershipHistory({ groupId: groupId(req), limit }),
      audit: () => groupApi.getAuditTrail({ groupId: groupId(req), limit }),
    };
    if (!map[kind]) return res.status(404).json({ success: false, message: `Unknown history kind "${kind}"` });
    const history = await map[kind]();
    return res.status(200).json({ success: true, kind, history });
  } catch (error) {
    return handleError(res, error, "getHistory");
  }
};

/** GET /health — aggregate control-plane health. */
export const health = async (_req, res) => {
  try {
    return res.status(200).json({ success: true, health: await groupApi.health() });
  } catch (error) {
    return handleError(res, error, "health");
  }
};

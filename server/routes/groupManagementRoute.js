/**
 * @module routes/groupManagementRoute
 *
 * Group Foundation & Membership Management API routes (Layer 10, Sprint 1), mounted at
 * `/api/group-management`. Every route is protected by the EXISTING `protectedRoute` JWT middleware; the
 * authenticated user is the acting caller and the manager permission- + rank-checks each mutation.
 *
 * This surface treats a Group as a first-class distributed entity — create/delete/archive, invite/
 * accept/reject, join/approve, leave/remove/ban/mute, transfer ownership, change roles, update versioned
 * metadata + permissions, and read members / roles / permissions / details / versions / replica state /
 * history. It is ADDITIVE and independent of the existing Layer 1 `/api/groups` chat routes, and carries
 * control-plane metadata ONLY (no message content / keys). Group messaging is a later sprint.
 *
 * Static / collection paths (`/health`, `/groups/mine`) precede the `/groups/:groupId` routes.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  createGroup,
  deleteGroup,
  archiveGroup,
  restoreGroup,
  inviteMember,
  acceptInvitation,
  rejectInvitation,
  joinGroup,
  approveJoinRequest,
  leaveGroup,
  removeMember,
  banMember,
  muteMember,
  unmuteMember,
  transferOwnership,
  changeRole,
  updateMetadata,
  updatePermissions,
  listMyGroups,
  getGroup,
  getGroupDetails,
  listMembers,
  getRoles,
  getPermissions,
  getVersions,
  getReplicaState,
  refreshReplicaState,
  getHistory,
  health,
} from "../controllers/groupManagementController.js";

const groupManagementRouter = express.Router();

// --- observability + collection --------------------------------------------
groupManagementRouter.get("/health", protectedRoute, health);
groupManagementRouter.get("/groups/mine", protectedRoute, listMyGroups);
groupManagementRouter.post("/groups", protectedRoute, createGroup);

// --- group lifecycle --------------------------------------------------------
groupManagementRouter.get("/groups/:groupId", protectedRoute, getGroup);
groupManagementRouter.get("/groups/:groupId/details", protectedRoute, getGroupDetails);
groupManagementRouter.delete("/groups/:groupId", protectedRoute, deleteGroup);
groupManagementRouter.post("/groups/:groupId/archive", protectedRoute, archiveGroup);
groupManagementRouter.post("/groups/:groupId/restore", protectedRoute, restoreGroup);

// --- membership: invitations ------------------------------------------------
groupManagementRouter.post("/groups/:groupId/invite", protectedRoute, inviteMember);
groupManagementRouter.post("/groups/:groupId/accept", protectedRoute, acceptInvitation);
groupManagementRouter.post("/groups/:groupId/reject", protectedRoute, rejectInvitation);

// --- membership: join / leave / moderation ----------------------------------
groupManagementRouter.post("/groups/:groupId/join", protectedRoute, joinGroup);
groupManagementRouter.post("/groups/:groupId/approve", protectedRoute, approveJoinRequest);
groupManagementRouter.post("/groups/:groupId/leave", protectedRoute, leaveGroup);
groupManagementRouter.post("/groups/:groupId/remove", protectedRoute, removeMember);
groupManagementRouter.post("/groups/:groupId/ban", protectedRoute, banMember);
groupManagementRouter.post("/groups/:groupId/mute", protectedRoute, muteMember);
groupManagementRouter.post("/groups/:groupId/unmute", protectedRoute, unmuteMember);

// --- ownership + roles ------------------------------------------------------
groupManagementRouter.post("/groups/:groupId/transfer-ownership", protectedRoute, transferOwnership);
groupManagementRouter.post("/groups/:groupId/roles", protectedRoute, changeRole);

// --- metadata + permissions -------------------------------------------------
groupManagementRouter.patch("/groups/:groupId/metadata", protectedRoute, updateMetadata);
groupManagementRouter.put("/groups/:groupId/permissions", protectedRoute, updatePermissions);

// --- reads ------------------------------------------------------------------
groupManagementRouter.get("/groups/:groupId/members", protectedRoute, listMembers);
groupManagementRouter.get("/groups/:groupId/roles", protectedRoute, getRoles);
groupManagementRouter.get("/groups/:groupId/permissions", protectedRoute, getPermissions);
groupManagementRouter.get("/groups/:groupId/versions", protectedRoute, getVersions);
groupManagementRouter.get("/groups/:groupId/replica", protectedRoute, getReplicaState);
groupManagementRouter.post("/groups/:groupId/replica/refresh", protectedRoute, refreshReplicaState);
groupManagementRouter.get("/groups/:groupId/history/:kind", protectedRoute, getHistory);

export default groupManagementRouter;

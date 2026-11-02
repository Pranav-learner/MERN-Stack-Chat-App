import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  createGroup,
  inviteToGroup,
  acceptInvite,
  rejectInvite,
  getMyGroups,
  getGroupMessages,
  sendGroupMessage,
  leaveGroup,
  removeMember,
  getGroupKeys,
  updateGroupKeys,
} from "../controllers/groupController.js";

const groupRouter = express.Router();

groupRouter.post("/create", protectedRoute, createGroup);
groupRouter.post("/invite", protectedRoute, inviteToGroup);
groupRouter.post("/accept", protectedRoute, acceptInvite);
groupRouter.post("/reject", protectedRoute, rejectInvite);
groupRouter.post("/leave", protectedRoute, leaveGroup);
groupRouter.post("/remove-member", protectedRoute, removeMember);
groupRouter.get("/my-groups", protectedRoute, getMyGroups);
groupRouter.get("/:groupId/messages", protectedRoute, getGroupMessages);
groupRouter.post("/send/:groupId", protectedRoute, sendGroupMessage);
groupRouter.get("/:groupId/keys", protectedRoute, getGroupKeys);
groupRouter.post("/:groupId/keys", protectedRoute, updateGroupKeys);

export default groupRouter;

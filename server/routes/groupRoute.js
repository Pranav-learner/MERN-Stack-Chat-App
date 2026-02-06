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
} from "../controllers/groupController.js";

const groupRouter = express.Router();

groupRouter.post("/create", protectedRoute, createGroup);
groupRouter.post("/invite", protectedRoute, inviteToGroup);
groupRouter.post("/accept", protectedRoute, acceptInvite);
groupRouter.post("/reject", protectedRoute, rejectInvite);
groupRouter.get("/my-groups", protectedRoute, getMyGroups);
groupRouter.get("/:groupId/messages", protectedRoute, getGroupMessages);
groupRouter.post("/send/:groupId", protectedRoute, sendGroupMessage);

export default groupRouter;

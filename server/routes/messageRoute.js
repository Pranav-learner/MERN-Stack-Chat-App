import express from "express";
import {
  getAllUsers,
  getAllMessages,
  markMessageAsSeen,
  sendMessage,
} from "../controllers/messageController.js";
import { protectedRoute } from "../middleware/authmiddleware.js";
// Layer 4 · Sprint 5 — session-aware messaging middleware (additive, non-blocking in
// PERMISSIVE mode): resolve + attach the session context, then refresh activity.
import { sessionMiddleware } from "../controllers/sessionMessagingController.js";

const { resolveSession, refreshSession } = sessionMiddleware;

const messageRouter = express.Router();

messageRouter.get("/users", protectedRoute, getAllUsers);
messageRouter.get("/:id", protectedRoute, getAllMessages);
messageRouter.put("/mark/:id", protectedRoute, markMessageAsSeen);
messageRouter.post("/send/:id", protectedRoute, resolveSession, refreshSession, sendMessage);

export default messageRouter;

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
// Layer 4 · Sprint 6 — validate an incoming ciphertext payload (server relay; never
// decrypts). Passes through when the send is plaintext (fallback).
import { secureTransportMiddleware } from "../controllers/secureTransportController.js";

const { resolveSession, refreshSession } = sessionMiddleware;
const { validateSecurePayload, requireCiphertext } = secureTransportMiddleware;

const messageRouter = express.Router();

messageRouter.get("/users", protectedRoute, getAllUsers);
messageRouter.get("/:id", protectedRoute, getAllMessages);
messageRouter.put("/mark/:id", protectedRoute, markMessageAsSeen);
messageRouter.post(
  "/send/:id",
  protectedRoute,
  resolveSession,
  refreshSession,
  validateSecurePayload,
  requireCiphertext,
  sendMessage,
);

export default messageRouter;

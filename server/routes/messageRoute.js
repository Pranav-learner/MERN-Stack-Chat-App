import express from "express";
import {
  getAllUsers,
  getAllMessages,
  markMessageAsSeen,
  sendMessage,
} from "../controllers/messageController.js";
import { protectedRoute } from "../middleware/authmiddleware.js";

const messageRouter = express.Router();

messageRouter.get("users", protectedRoute, getAllUsers);
messageRouter.get("/:id", protectedRoute, getAllMessages);
messageRouter.put("/mark/:id", protectedRoute, markMessageAsSeen);
messageRouter.post("/send/:id", protectedRoute, sendMessage);

export default messageRouter;

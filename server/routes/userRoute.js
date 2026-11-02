import express from "express";
import {
  signup,
  login,
  updateProfile,
  isAuthenticated,
} from "../controllers/userController.js";
import { protectedRoute } from "../middleware/authmiddleware.js";
import { authLimiter } from "../middleware/rateLimiter.js";

const userRouter = express.Router();

userRouter.post("/signup", authLimiter, signup);
userRouter.post("/login", authLimiter, login);
userRouter.put("/update-profile", protectedRoute, updateProfile);
userRouter.get("/check", protectedRoute, isAuthenticated);

export default userRouter;

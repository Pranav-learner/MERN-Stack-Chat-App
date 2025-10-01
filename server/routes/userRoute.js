import express from "express";
import {
  signup,
  login,
  updateProfile,
  isAuthenticated,
} from "../controllers/userController.js";
import { protectedRoute } from "../middleware/authmiddleware.js";

const userRouter = express.Router();

userRouter.post("/signup", signup);
userRouter.post("/login", login);
userRouter.put("/update-profile", protectedRoute, updateProfile);
userRouter.get("/check", protectedRoute, isAuthenticated);

export default userRouter;

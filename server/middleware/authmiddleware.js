import jwt from "jsonwebtoken";
import User from "../models/userModel.js";

// Middleware to check if user is authenticated
export const protectedRoute = async (req, res, next) => {
  try {
    // get the token from the headers
    const token = req.headers.token;
    // verify the token
    const decode = jwt.verify(token, process.env.JWT_SECRET);
    // finding the user in our databse
    const user = await User.findById(decode.id).select("-password");

    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }
    // pass the user to the next middleware
    req.user = user;
    next();
  } catch (error) {
    console.log(error);
    res.status(401).json({ message: "Unauthorized" });
  }
};

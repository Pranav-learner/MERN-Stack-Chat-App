import User from "../models/User.model.js";
import bcrypt from "bcryptjs";
import { generateToken } from "../lib/utils.js";
import cloudinary from "../lib/cloudinary.js";

const sanitizeUser = (user) => {
  if (!user) return null;
  const userObj = user.toObject ? user.toObject() : { ...user };
  delete userObj.password;
  return userObj;
};

// Signup a new user
export const signup = async (req, res) => {
  try {
    const { fullName, email, password, bio } = req.body;

    const trimmedName = fullName?.trim();
    const trimmedEmail = email?.trim()?.toLowerCase();
    const trimmedBio = bio?.trim() || "";

    // Check if required fields are filled
    if (!trimmedName || !trimmedEmail || !password) {
      return res
        .status(400)
        .json({ success: false, message: "All fields are required" });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      return res
        .status(400)
        .json({ success: false, message: "Please provide a valid email address" });
    }

    // Validate password strength
    if (password.length < 6) {
      return res
        .status(400)
        .json({ success: false, message: "Password must be at least 6 characters" });
    }

    // Check if user already exists
    const userExists = await User.findOne({ email: trimmedEmail });
    if (userExists) {
      return res
        .status(400)
        .json({ success: false, message: "User already exists" });
    }

    // Hashing password for security
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = await User.create({
      fullName: trimmedName,
      email: trimmedEmail,
      password: hashedPassword,
      bio: trimmedBio,
    });

    const token = generateToken(newUser._id);

    res.status(201).json({
      success: true,
      userData: sanitizeUser(newUser),
      token,
      message: "User created successfully",
    });
  } catch (error) {
    console.error("Error in signup controller:", error.message);
    res.status(500).json({ success: false, message: "Failed to create account" });
  }
};

// Login a user
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const trimmedEmail = email?.trim()?.toLowerCase();

    // Check if all fields are filled
    if (!trimmedEmail || !password) {
      return res
        .status(400)
        .json({ success: false, message: "All fields are required" });
    }

    // Check if user exists
    const user = await User.findOne({ email: trimmedEmail });
    if (!user) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid credentials" });
    }

    // Check if password is correct
    const isPasswordCorrect = await bcrypt.compare(password, user.password);
    if (!isPasswordCorrect) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid credentials" });
    }

    // Generate token
    const token = generateToken(user._id);

    res.status(200).json({
      success: true,
      userData: sanitizeUser(user),
      token,
      message: "User logged in successfully",
    });
  } catch (error) {
    console.error("Error in login controller:", error.message);
    res.status(500).json({
      success: false,
      message: "Internal server error during login",
    });
  }
};

// Controller to check if User is authenticated
export const isAuthenticated = async (req, res) => {
  const user = req.user;
  res
    .status(200)
    .json({ success: true, user: sanitizeUser(user), message: "User is authenticated" });
};

// Controller to update user profile detail
export const updateProfile = async (req, res) => {
  try {
    const { profilePic, fullName, bio } = req.body;
    const userId = req.user._id;

    const user = await User.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    let updateduser;

    if (!profilePic) {
      updateduser = await User.findByIdAndUpdate(
        userId,
        {
          fullName: fullName ? fullName.trim() : user.fullName,
          bio: bio !== undefined ? bio.trim() : user.bio,
        },
        { new: true }
      ).select("-password");
    } else {
      const upload = await cloudinary.uploader.upload(profilePic);
      updateduser = await User.findByIdAndUpdate(
        userId,
        {
          fullName: fullName ? fullName.trim() : user.fullName,
          bio: bio !== undefined ? bio.trim() : user.bio,
          profilePic: upload.secure_url,
        },
        { new: true }
      ).select("-password");
    }

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      user: sanitizeUser(updateduser),
    });
  } catch (error) {
    console.error("Error in updateProfile controller:", error.message);
    res.status(500).json({ success: false, message: "Failed to update profile" });
  }
};

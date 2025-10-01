import User from "../models/userModel.js";
import Message from "../models/Message.model.js";
import cloudinary from "../lib/cloudinary.js";
import { io } from "../server.js";
import { userSocketMap } from "../server.js";

// Get all users except the logged in user
export const getAllUsers = async (req, res) => {
  try {
    const userId = req.user._id;
    const filteredUsers = await User.find({ _id: { $ne: userId } }).select(
      "-password"
    );

    // Count no. of unread messages for each user
    const unseenMessages = {};
    const promises = filteredUsers.map(async (user) => {
      const messages = await Message.find({
        senderId: user._id,
        receiverId: userId,
        seen: false,
      });
      if (messages.length > 0) {
        unseenMessages[user._id] = messages.length;
      }
    });
    await Promise.all(promises);
    res.json({ success: true, users: filteredUsers, unseenMessages });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: error.message });
  }
};

// Get all messages for selected user
export const getAllMessages = async (req, res) => {
  try {
    // getting both id , to get both messages
    const { userId } = req.params;
    const myId = req.user._id;

    const messages = await Message.find({
      $or: [
        { senderId: myId, receiverId: userId },
        { senderId: userId, receiverId: myId },
      ],
    });
    await Message.updateMany(
      { senderId: userId, receiverId: myId },
      { seen: true }
    );

    res.json({ success: true, messages });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: error.message });
  }
};

// Seen messages for selected user

export const markMessageAsSeen = async (req, res) => {
  try {
    const { userId } = req.params;
    await Message.findByIdAndUpdate(userId, { seen: true });
    res.status(200).json({ success: true, message: "Messages marked as seen" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Controller to esnd message

export const sendMessage = async (req, res) => {
  try {
    const { text, image } = req.body;
    const receiverId = req.params.id;
    const senderId = req.user._id;
    let imageUrl;

    // Upload image to Cloudinary
    if (image) {
      const upload = await cloudinary.uploader.upload(image);
      imageUrl = upload.secure_url;
    }
    // Create a new message
    const newMessage = await Message.create({
      senderId,
      receiverId,
      text,
      image: imageUrl,
    });

    // Emit the new message to the receiver's socket
    const receiverSocketId = userSocketMap[receiverId];
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("newMessage", newMessage);
    }

    res.status(201).json({ success: true, message: newMessage });
  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: error.message });
  }
};

import User from "../models/User.model.js";
import Message from "../models/Message.model.js";
import cloudinary from "../lib/cloudinary.js";
import { io } from "../server.js";
import { getUserSocket } from "../lib/redis.js"; // Import Redis helper

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
        status: { $ne: "read" }, // Logic change for status
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

// ... existing getAllMessages ...

// Controller to send message

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
      status: "sent",
    });

    // Emit the new message to the receiver's socket
    const receiverSocketId = await getUserSocket(receiverId); // Get from Redis
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("newMessage", newMessage);
      // Update status to delivered immediately if user is online
      newMessage.status = "delivered";
      await newMessage.save();
      // Notify sender that message updates
      const senderSocketId = await getUserSocket(senderId);
      if(senderSocketId) {
          io.to(senderSocketId).emit("messageStatusUpdate", newMessage);
      }
    }

    res.status(201).json({ success: true, message: newMessage });
  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get all messages for selected user
export const getAllMessages = async (req, res) => {
  try {
    const userId = req.params.id; // The other user (sender of messages)
    const myId = req.user._id;

    const messages = await Message.find({
      $or: [
        { senderId: myId, receiverId: userId },
        { senderId: userId, receiverId: myId },
      ],
    });

    // Mark incoming messages as read
    const updateResult = await Message.updateMany(
      { senderId: userId, receiverId: myId, status: { $ne: "read" } },
      { status: "read" }
    );

    // If any messages were updated, notify the sender
    if (updateResult.modifiedCount > 0) {
        const senderSocketId = await getUserSocket(userId);
        if (senderSocketId) {
            io.to(senderSocketId).emit("messagesRead", { readerId: myId });
        }
    }

    res.json({ success: true, messages });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: error.message });
  }
};

// Seen messages for selected user

// Mark messages as read manually (if needed)
export const markMessageAsSeen = async (req, res) => {
  try {
    const { userId } = req.params; // The sender whose messages I'm reading
    const myId = req.user._id;

    const updateResult = await Message.updateMany(
        { senderId: userId, receiverId: myId, status: { $ne: "read" } }, 
        { status: "read" }
    );

    if (updateResult.modifiedCount > 0) {
        const senderSocketId = await getUserSocket(userId);
        if (senderSocketId) {
            io.to(senderSocketId).emit("messagesRead", { readerId: myId });
        }
    }

    res.status(200).json({ success: true, message: "Messages marked as read" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Controller to send message



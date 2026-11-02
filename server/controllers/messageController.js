import User from "../models/User.model.js";
import Message from "../models/Message.model.js";
import cloudinary from "../lib/cloudinary.js";
import { io } from "../server.js";
import { getUserSocket, getUserSockets } from "../lib/redis.js"; // Import Redis helpers
// Layer 4 · Sprint 5 — Secure Session Integration: route sends through the session-aware
// message pipeline (resolve → validate → prepare secure payload → transport). Additive;
// PERMISSIVE by default so existing messaging keeps working when no session exists.
import { messagePipeline } from "./sessionMessagingController.js";
import { sessionMetadataOf } from "../session-integration/index.js";
// Layer 4 · Sprint 6 — Secure Transport: the server RELAYS ciphertext (never decrypts).
import { relayManager } from "./secureTransportController.js";
import { toStoredCiphertext } from "../secure-transport/index.js";

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
    const { text, image, securePayload } = req.body;
    const receiverId = req.params.id;
    const senderId = req.user._id;

    // Validate recipient
    if (!receiverId || String(receiverId) === String(senderId)) {
      return res.status(400).json({ success: false, message: "Invalid recipient" });
    }

    // Validate message content
    if (!securePayload && (!text || !text.trim()) && !image) {
      return res.status(400).json({ success: false, message: "Message must contain text or image" });
    }

    // === End-to-end encrypted path (Layer 4 · Sprint 6) ===================
    // The client encrypted the message with its device-local session keys. The
    // server is a RELAY: it validates the ciphertext's structure/binding, persists
    // CIPHERTEXT ONLY, and delivers it. It never decrypts (it holds no keys).
    if (securePayload) {
      const { payload } = relayManager.relay(securePayload, { sessionId: req.body?.sessionId });
      const stored = toStoredCiphertext(payload, { senderId, receiverId });
      const newMessage = await Message.create({
        senderId,
        receiverId,
        status: "sent",
        secure: stored.secure,
        session: {
          sessionId: payload.sessionId,
          keyId: payload.keyId,
          secured: true,
          transportMode: "session",
          fallback: false,
        },
      });

      const receiverSocketIds = await getUserSockets(receiverId);
      if (receiverSocketIds.length > 0) {
        receiverSocketIds.forEach((sid) => io.to(sid).emit("newMessage", newMessage));
        newMessage.status = "delivered";
        await newMessage.save();
      }
      const senderSocketIds = await getUserSockets(senderId);
      senderSocketIds.forEach((sid) => io.to(sid).emit("messageStatusUpdate", newMessage));

      return res.status(201).json({ success: true, message: newMessage, encrypted: true });
    }

    // === Plaintext / session-aware fallback path (Sprint 5) ===============
    let imageUrl;

    // Upload image to Cloudinary
    if (image) {
      const upload = await cloudinary.uploader.upload(image);
      imageUrl = upload.secure_url;
    }

    // Route the send through the session-aware message pipeline. The transport
    // persists the message (tagged with its PUBLIC session metadata) and emits it —
    // the existing delivery behaviour, now session-aware.
    const { context, delivery: newMessage } = await messagePipeline.process({
      sender: String(senderId),
      recipient: String(receiverId),
      message: { text: text ? text.trim() : undefined, image: imageUrl },
      transport: async (envelope) => {
        const created = await Message.create({
          senderId,
          receiverId,
          text: envelope.payload.text,
          image: envelope.payload.image,
          status: "sent",
          session: sessionMetadataOf(envelope),
        });

        // Emit to all receiver sockets
        const receiverSocketIds = await getUserSockets(receiverId);
        if (receiverSocketIds.length > 0) {
          receiverSocketIds.forEach((sid) => io.to(sid).emit("newMessage", created));
          created.status = "delivered";
          await created.save();
        }
        const senderSocketIds = await getUserSockets(senderId);
        senderSocketIds.forEach((sid) => io.to(sid).emit("messageStatusUpdate", created));

        return created;
      },
    });

    res.status(201).json({ success: true, message: newMessage, session: context });
  } catch (error) {
    console.error("Error in sendMessage controller:", error.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Get all messages for selected user
export const getAllMessages = async (req, res) => {
  try {
    const userId = req.params.id; // The other user (sender of messages)
    const myId = req.user._id;

    if (!userId) {
      return res.status(400).json({ success: false, message: "User ID is required" });
    }

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

    // If any messages were updated, notify all of sender's sockets
    if (updateResult.modifiedCount > 0) {
      const senderSocketIds = await getUserSockets(userId);
      senderSocketIds.forEach((sid) => io.to(sid).emit("messagesRead", { readerId: myId }));
    }

    res.json({ success: true, messages });
  } catch (error) {
    console.error("Error in getAllMessages controller:", error.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Mark messages as read manually
export const markMessageAsSeen = async (req, res) => {
  try {
    const { userId } = req.params; // The sender whose messages I'm reading
    const myId = req.user._id;

    const updateResult = await Message.updateMany(
      { senderId: userId, receiverId: myId, status: { $ne: "read" } }, 
      { status: "read" }
    );

    if (updateResult.modifiedCount > 0) {
      const senderSocketIds = await getUserSockets(userId);
      senderSocketIds.forEach((sid) => io.to(sid).emit("messagesRead", { readerId: myId }));
    }

    res.status(200).json({ success: true, message: "Messages marked as read" });
  } catch (error) {
    console.error("Error in markMessageAsSeen controller:", error.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Controller to send message



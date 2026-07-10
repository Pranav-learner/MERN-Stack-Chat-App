import User from "../models/User.model.js";
import Message from "../models/Message.model.js";
import cloudinary from "../lib/cloudinary.js";
import { io } from "../server.js";
import { getUserSocket } from "../lib/redis.js"; // Import Redis helper
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

      const receiverSocketId = await getUserSocket(receiverId);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("newMessage", newMessage); // delivers ciphertext
        newMessage.status = "delivered";
        await newMessage.save();
        const senderSocketId = await getUserSocket(senderId);
        if (senderSocketId) io.to(senderSocketId).emit("messageStatusUpdate", newMessage);
      }
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
    // the existing delivery behaviour, now session-aware. In Layer 5 the same pipeline
    // will seal the payload via the encryption interceptor with zero controller change.
    const { context, delivery: newMessage } = await messagePipeline.process({
      sender: String(senderId),
      recipient: String(receiverId),
      message: { text, image: imageUrl },
      transport: async (envelope) => {
        const created = await Message.create({
          senderId,
          receiverId,
          text: envelope.payload.text,
          image: envelope.payload.image,
          status: "sent",
          session: sessionMetadataOf(envelope),
        });

        // Emit to the receiver's socket (unchanged delivery + status logic).
        const receiverSocketId = await getUserSocket(receiverId);
        if (receiverSocketId) {
          io.to(receiverSocketId).emit("newMessage", created);
          created.status = "delivered";
          await created.save();
          const senderSocketId = await getUserSocket(senderId);
          if (senderSocketId) {
            io.to(senderSocketId).emit("messageStatusUpdate", created);
          }
        }
        return created;
      },
    });

    res.status(201).json({ success: true, message: newMessage, session: context });
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



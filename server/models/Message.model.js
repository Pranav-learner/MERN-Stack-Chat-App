import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: false,
    },
    text: { type: String },
    // seen: { type: Boolean, default: false }, // Deprecated
    status: {
      type: String,
      enum: ["sent", "delivered", "read"],
      default: "sent",
    },
    image: { type: String },
    // Layer 4 · Sprint 5 — Secure Session awareness (additive, PUBLIC metadata only).
    // `secured` stays false in Layer 4; Layer 5 flips it and moves ciphertext into the
    // message. No key bytes are ever stored here.
    session: {
      sessionId: { type: String, default: null },
      keyId: { type: String, default: null },
      secured: { type: Boolean, default: false },
      transportMode: { type: String, enum: ["session", "fallback"], default: "fallback" },
      fallback: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

const Message = mongoose.model("Message", messageSchema);

export default Message;

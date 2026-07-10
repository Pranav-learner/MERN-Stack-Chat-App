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
    session: {
      sessionId: { type: String, default: null },
      keyId: { type: String, default: null },
      secured: { type: Boolean, default: false },
      transportMode: { type: String, enum: ["session", "fallback"], default: "fallback" },
      fallback: { type: Boolean, default: true },
    },
    // Layer 4 · Sprint 6 — Secure Transport: the END-TO-END ENCRYPTED envelope.
    // The server stores CIPHERTEXT + metadata ONLY — never plaintext, keys, or shared
    // secrets. When `secure.encrypted` is true, `text`/`image` are absent. The server
    // cannot decrypt this (it has no session keys); only the participant devices can.
    secure: {
      encrypted: { type: Boolean, default: false },
      v: { type: Number },
      payloadVersion: { type: Number },
      type: { type: String },
      protocolVersion: { type: String },
      sessionId: { type: String },
      keyId: { type: String },
      senderDevice: { type: String },
      receiverDevice: { type: String },
      timestamp: { type: Number }, // exact AAD timestamp (needed to decrypt)
      nonce: { type: String },
      algorithm: { type: String }, // aes-256-gcm
      iv: { type: String }, // base64
      ciphertext: { type: String }, // base64
      tag: { type: String }, // base64 (AEAD auth tag)
      macAlgorithm: { type: String }, // hmac-sha256
      mac: { type: String }, // base64 (encrypt-then-MAC)
    },
  },
  { timestamps: true }
);

const Message = mongoose.model("Message", messageSchema);

export default Message;

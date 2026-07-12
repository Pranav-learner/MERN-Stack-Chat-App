/**
 * @module group-communication/models/GroupMessage
 *
 * Mongoose schema for a group message (Layer 10, Sprint 2). NEW collection (`groupmessages`); additive.
 * Stores OPAQUE ciphertext + a content-hash commitment + the key version it was encrypted under — never
 * plaintext or keys. The engine is a blind relay; it never decrypts.
 */

import mongoose from "mongoose";

const groupMessageSchema = new mongoose.Schema(
  {
    messageId: { type: String, required: true, unique: true, index: true },
    groupId: { type: String, required: true, index: true },
    conversationId: { type: String, index: true },
    senderId: { type: String, required: true, index: true },
    keyVersion: { type: Number, required: true },
    ciphertext: { type: String, required: true }, // opaque (base64/string)
    contentHash: { type: String },
    priority: { type: String, default: "normal" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: String, index: true },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

groupMessageSchema.index({ groupId: 1, createdAt: -1 });

const GroupMessage = mongoose.models.GroupMessage || mongoose.model("GroupMessage", groupMessageSchema);
export default GroupMessage;

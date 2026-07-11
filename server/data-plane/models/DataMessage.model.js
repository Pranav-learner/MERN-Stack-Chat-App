/**
 * @module data-plane/models/DataMessage
 *
 * Mongoose schema for a transported application message (Layer 8, Sprint 1). NEW collection;
 * additive — it does NOT modify the existing `Message` chat collection or any prior schema.
 *
 * @security Stores the message's delivery CONTROL-PLANE metadata + the OPAQUE `encryptedPayload`
 * (the crypto layer's ciphertext envelope — Mixed, never inspected). There is deliberately **NO
 * field** for plaintext, a private key, session key, message key, chain key, or shared secret.
 */

import mongoose from "mongoose";

const dataMessageSchema = new mongoose.Schema(
  {
    messageId: { type: String, required: true, unique: true, index: true },
    conversationId: { type: String, required: true, index: true },
    senderDeviceId: { type: String, required: true, index: true },
    receiverDeviceId: { type: String, required: true, index: true },
    // OPAQUE ciphertext envelope from the crypto layer — never plaintext.
    encryptedPayload: { type: mongoose.Schema.Types.Mixed, required: true },
    sequenceNumber: { type: Number, required: true },
    timestamp: { type: String },
    priority: { type: String, enum: ["high", "normal", "low"], default: "normal" },
    state: {
      type: String,
      enum: ["created", "queued", "sending", "sent", "delivered", "acknowledged", "failed", "expired", "cancelled", "destroyed"],
      required: true,
      index: true,
    },
    retryCount: { type: Number, default: 0 },
    connectionId: { type: String, default: null, index: true },
    fragment: { type: mongoose.Schema.Types.Mixed, default: {} }, // FUTURE placeholder (Sprint 2)
    transportMetadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    auditMetadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    sentAt: { type: String, default: null },
    deliveredAt: { type: String, default: null },
    ackedAt: { type: String, default: null },
    nextRetryAt: { type: String, default: null, index: true },
    expiresAt: { type: String, index: true },
    version: { type: Number, default: 1 },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

dataMessageSchema.index({ conversationId: 1, sequenceNumber: 1 });
dataMessageSchema.index({ state: 1, nextRetryAt: 1 });
dataMessageSchema.index({ state: 1, expiresAt: 1 });

const DataMessage = mongoose.models.DataMessage || mongoose.model("DataMessage", dataMessageSchema);

export default DataMessage;

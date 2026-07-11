/**
 * @module data-plane/models/InboundMessage
 *
 * Mongoose schema for an inbound message delivered to the application (Layer 8, Sprint 1). NEW
 * collection; additive. Kept for duplicate history + audit + reconnect recovery.
 *
 * @security Stores delivery metadata + the OPAQUE ciphertext (Mixed). No plaintext / key material.
 */

import mongoose from "mongoose";

const inboundMessageSchema = new mongoose.Schema(
  {
    messageId: { type: String, required: true, unique: true, index: true },
    conversationId: { type: String, required: true, index: true },
    senderDeviceId: { type: String, index: true },
    receiverDeviceId: { type: String, index: true },
    encryptedPayload: { type: mongoose.Schema.Types.Mixed, required: true },
    sequenceNumber: { type: Number, required: true },
    receivedAt: { type: String },
    deliveredAt: { type: String },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

inboundMessageSchema.index({ conversationId: 1, sequenceNumber: 1 });

const InboundMessage = mongoose.models.InboundMessage || mongoose.model("InboundMessage", inboundMessageSchema);

export default InboundMessage;

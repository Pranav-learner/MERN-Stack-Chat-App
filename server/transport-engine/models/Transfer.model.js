/**
 * @module transport-engine/models/Transfer
 *
 * Mongoose schema for a large-payload TRANSFER (Layer 8, Sprint 2). NEW collection; additive — it does
 * NOT modify any existing schema. Stores transfer CONTROL-PLANE metadata + progress only; the opaque
 * ciphertext fragments live in the separate `TransferChunk` collection.
 *
 * @security No field for plaintext or key material. `payloadMeta.checksum` + per-chunk checksums are
 * integrity hashes over ciphertext, not secrets.
 */

import mongoose from "mongoose";

const transferSchema = new mongoose.Schema(
  {
    transferId: { type: String, required: true, unique: true, index: true },
    conversationId: { type: String, required: true, index: true },
    senderDeviceId: { type: String, required: true, index: true },
    receiverDeviceId: { type: String, required: true, index: true },
    direction: { type: String, enum: ["outbound", "inbound"], required: true },
    state: {
      type: String,
      enum: ["created", "fragmenting", "active", "paused", "reassembling", "completed", "failed", "cancelled", "expired", "destroyed"],
      required: true,
      index: true,
    },
    priority: { type: String, default: "file" },
    // Opaque-safe payload metadata (size/count/kind/checksum) — NEVER plaintext.
    payloadMeta: { type: mongoose.Schema.Types.Mixed, required: true },
    chunksAcked: { type: Number, default: 0 },
    chunksReceived: { type: Number, default: 0 },
    bytesTransferred: { type: Number, default: 0 },
    stream: { type: mongoose.Schema.Types.Mixed, default: {} }, // FUTURE media seam (Layer 11)
    auditMetadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    failureReason: { type: String, default: null },
    expiresAt: { type: String, index: true },
    version: { type: Number, default: 1 },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

transferSchema.index({ conversationId: 1, createdAt: -1 });
transferSchema.index({ state: 1, expiresAt: 1 });

const Transfer = mongoose.models.Transfer || mongoose.model("Transfer", transferSchema);
export default Transfer;

/**
 * @module transport-reliability/models/TransferReliability
 *
 * Mongoose schema for a transfer's RELIABILITY record (Layer 8, Sprint 3). NEW collection; additive.
 * Stores reliability control-plane metadata + the resumable checkpoint only — no payload, no keys.
 */

import mongoose from "mongoose";

const transferReliabilitySchema = new mongoose.Schema(
  {
    transferId: { type: String, required: true, unique: true, index: true },
    conversationId: { type: String, required: true, index: true },
    senderDeviceId: { type: String, required: true, index: true },
    receiverDeviceId: { type: String, required: true, index: true },
    connectionId: { type: String, default: null, index: true },
    state: {
      type: String,
      enum: ["tracking", "degraded", "interrupted", "recovering", "migrating", "completed", "failed", "abandoned"],
      required: true,
      index: true,
    },
    priority: { type: String, default: "file" },
    // Resumable checkpoint — chunk COUNTS + high-water mark, never payload bytes.
    checkpoint: { type: mongoose.Schema.Types.Mixed, default: {} },
    health: { type: mongoose.Schema.Types.Mixed, default: {} },
    recoveryCount: { type: Number, default: 0 },
    resumeCount: { type: Number, default: 0 },
    migrationCount: { type: Number, default: 0 },
    retryPolicy: { type: mongoose.Schema.Types.Mixed, default: {} },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    failureReason: { type: String, default: null },
    registeredAt: { type: String },
    lastActivityAt: { type: String, index: true },
    expiresAt: { type: String, index: true },
    version: { type: Number, default: 1 },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

transferReliabilitySchema.index({ state: 1, lastActivityAt: 1 });
transferReliabilitySchema.index({ conversationId: 1, registeredAt: -1 });

const TransferReliability = mongoose.models.TransferReliability || mongoose.model("TransferReliability", transferReliabilitySchema);
export default TransferReliability;

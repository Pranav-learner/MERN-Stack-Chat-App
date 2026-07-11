/**
 * @module synchronization-reliability/models/SyncReliability
 *
 * Mongoose schema for a synchronization's RELIABILITY record (Layer 9, Sprint 3). NEW collection;
 * additive. Stores reliability control-plane metadata + the resumable checkpoint only — no content, no
 * keys.
 */

import mongoose from "mongoose";

const syncReliabilitySchema = new mongoose.Schema(
  {
    syncId: { type: String, required: true, unique: true, index: true },
    sessionId: { type: String, index: true },
    replicaId: { type: String, index: true },
    deviceId: { type: String, required: true, index: true },
    userId: { type: String, index: true },
    state: {
      type: String,
      enum: ["tracking", "degraded", "interrupted", "recovering", "completed", "failed", "abandoned"],
      required: true,
      index: true,
    },
    checkpoint: { type: mongoose.Schema.Types.Mixed, default: {} },
    health: { type: mongoose.Schema.Types.Mixed, default: {} },
    recoveryCount: { type: Number, default: 0 },
    resumeCount: { type: Number, default: 0 },
    retryCount: { type: Number, default: 0 },
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

syncReliabilitySchema.index({ state: 1, lastActivityAt: 1 });
syncReliabilitySchema.index({ userId: 1, registeredAt: -1 });

const SyncReliability = mongoose.models.SyncReliability || mongoose.model("SyncReliability", syncReliabilitySchema);
export default SyncReliability;

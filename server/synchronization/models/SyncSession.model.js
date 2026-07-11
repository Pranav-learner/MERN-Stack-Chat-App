/**
 * @module synchronization/models/SyncSession
 *
 * Mongoose schema for a synchronization SESSION (Layer 9, Sprint 1). NEW collection; additive. Tracks
 * session lifecycle + progress + resume cursor — metadata only.
 */

import mongoose from "mongoose";

const syncSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    sourceReplicaId: { type: String, index: true },
    targetReplicaId: { type: String, required: true, index: true },
    deviceId: { type: String, required: true, index: true },
    userId: { type: String, index: true },
    direction: { type: String, enum: ["pull", "push"], default: "pull" },
    state: {
      type: String,
      enum: ["created", "running", "paused", "completed", "cancelled", "expired", "failed"],
      required: true,
      index: true,
    },
    categories: { type: [String], default: [] },
    planId: { type: String, default: null },
    progress: { type: mongoose.Schema.Types.Mixed, default: {} },
    resumeCursor: { type: Number, default: 0 },
    recovery: { type: mongoose.Schema.Types.Mixed, default: {} },
    failureReason: { type: String, default: null },
    expiresAt: { type: String, index: true },
    version: { type: Number, default: 1 },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

syncSessionSchema.index({ state: 1, expiresAt: 1 });
syncSessionSchema.index({ deviceId: 1, createdAt: -1 });

const SyncSession = mongoose.models.SyncSession || mongoose.model("SyncSession", syncSessionSchema);
export default SyncSession;

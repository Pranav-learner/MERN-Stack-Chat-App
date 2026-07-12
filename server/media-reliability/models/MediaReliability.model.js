/**
 * @module media-reliability/models/MediaReliability
 *
 * Mongoose schema for a media-operation reliability record (Layer 11, Sprint 3). NEW collection
 * (`mediareliabilities`); additive. Stores reliability state + monotonic checkpoint + health + recovery
 * counters — CONTROL-PLANE metadata only (no media content or keys).
 */

import mongoose from "mongoose";

const mediaReliabilitySchema = new mongoose.Schema(
  {
    operationId: { type: String, required: true, unique: true, index: true },
    mediaId: { type: String, required: true, index: true },
    operationType: { type: String, required: true, index: true },
    deviceId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    state: { type: String, default: "tracking", index: true },
    checkpoint: { type: mongoose.Schema.Types.Mixed, default: {} },
    health: { type: mongoose.Schema.Types.Mixed, default: {} },
    storageProvider: { type: String, default: null },
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

mediaReliabilitySchema.index({ mediaId: 1, state: 1 });
mediaReliabilitySchema.index({ userId: 1, state: 1 });
mediaReliabilitySchema.index({ state: 1, lastActivityAt: 1 });

const MediaReliability = mongoose.models.MediaReliability || mongoose.model("MediaReliability", mediaReliabilitySchema);
export default MediaReliability;

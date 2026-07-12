/**
 * @module media-delivery/models/MediaAvailability
 *
 * Mongoose schema for a per-device media-availability replica + the offline media queue (Layer 11,
 * Sprint 2). TWO additive collections keyed by document type — the replica (`mediaavailabilities`) and
 * the offline queue (`mediaofflinequeues`). Media ids + availability + versions ONLY — no content/keys.
 */

import mongoose from "mongoose";

const mediaAvailabilitySchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, index: true },
    available: { type: [String], default: [] },
    availableCount: { type: Number, default: 0 },
    version: { type: Number, default: 1 },
    fingerprint: { type: String },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

const mediaOfflineQueueSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, index: true },
    mediaId: { type: String, required: true, index: true },
    priority: { type: String, default: "normal" },
    at: { type: String },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

mediaOfflineQueueSchema.index({ deviceId: 1, mediaId: 1 }, { unique: true });

export const MediaAvailability = mongoose.models.MediaAvailability || mongoose.model("MediaAvailability", mediaAvailabilitySchema);
export const MediaOfflineQueue = mongoose.models.MediaOfflineQueue || mongoose.model("MediaOfflineQueue", mediaOfflineQueueSchema);
export default MediaAvailability;

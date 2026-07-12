/**
 * @module media-delivery/models/MediaPreview
 *
 * Mongoose schema for a preview/thumbnail record (Layer 11, Sprint 2). NEW collection (`mediapreviews`);
 * additive. Tracks the async generation state + version + a metadata descriptor (dimensions / format /
 * an optional encrypted-thumbnail media id) + generation history — metadata only, never pixels or keys.
 */

import mongoose from "mongoose";

const mediaPreviewSchema = new mongoose.Schema(
  {
    previewId: { type: String, required: true, unique: true, index: true },
    mediaId: { type: String, required: true, index: true },
    kind: { type: String, required: true, index: true },
    state: { type: String, default: "pending", index: true },
    version: { type: Number, default: 0 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    history: { type: [mongoose.Schema.Types.Mixed], default: [] },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

mediaPreviewSchema.index({ mediaId: 1, kind: 1 }, { unique: true });

const MediaPreview = mongoose.models.MediaPreview || mongoose.model("MediaPreview", mediaPreviewSchema);
export default MediaPreview;

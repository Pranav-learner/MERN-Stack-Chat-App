/**
 * @module media-reliability/models/MediaReliabilityAlert
 *
 * Mongoose schema for a raised monitor alert (Layer 11, Sprint 3). NEW collection
 * (`mediareliabilityalerts`); additive. Stores alert type + severity + numeric details — never content
 * or keys.
 */

import mongoose from "mongoose";

const mediaReliabilityAlertSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, index: true },
    severity: { type: String, default: "warning", index: true },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: String, index: true },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

mediaReliabilityAlertSchema.index({ type: 1, at: -1 });

const MediaReliabilityAlert = mongoose.models.MediaReliabilityAlert || mongoose.model("MediaReliabilityAlert", mediaReliabilityAlertSchema);
export default MediaReliabilityAlert;

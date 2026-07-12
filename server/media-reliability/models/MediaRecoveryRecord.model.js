/**
 * @module media-reliability/models/MediaRecoveryRecord
 *
 * Mongoose schema for a media-operation recovery-attempt audit entry (Layer 11, Sprint 3). NEW collection
 * (`mediarecoveryrecords`); additive. Also backs the media-operation audit trail (`kind: "audit"`).
 * Metadata only — never content or keys.
 */

import mongoose from "mongoose";

const mediaRecoveryRecordSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["recovery", "audit"], default: "recovery", index: true },
    operationId: { type: String, index: true },
    mediaId: { type: String, index: true },
    operation: { type: String },
    trigger: { type: String },
    action: { type: String },
    outcome: { type: String },
    attempt: { type: Number },
    actingDevice: { type: String },
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: String, index: true },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

mediaRecoveryRecordSchema.index({ kind: 1, operationId: 1, at: -1 });
mediaRecoveryRecordSchema.index({ kind: 1, mediaId: 1, at: -1 });

const MediaRecoveryRecord = mongoose.models.MediaRecoveryRecord || mongoose.model("MediaRecoveryRecord", mediaRecoveryRecordSchema);
export default MediaRecoveryRecord;

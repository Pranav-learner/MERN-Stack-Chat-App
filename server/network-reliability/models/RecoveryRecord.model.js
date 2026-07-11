/**
 * @module network-reliability/models/RecoveryRecord
 *
 * Mongoose schema for an append-only recovery-history record (Layer 7, Sprint 3). NEW collection;
 * additive. One record per recovery attempt (for diagnostics + observability).
 *
 * @security PUBLIC recovery metadata only — trigger, action, outcome, timings. No key material.
 */

import mongoose from "mongoose";

const recoveryRecordSchema = new mongoose.Schema(
  {
    recoveryId: { type: String, index: true },
    connectionId: { type: String, required: true, index: true },
    deviceId: { type: String, index: true },
    trigger: { type: String, index: true },
    action: { type: String },
    recovered: { type: Boolean, default: false },
    sessionPreserved: { type: Boolean, default: false },
    attempts: { type: Number, default: 0 },
    elapsedMs: { type: Number, default: 0 },
    reason: { type: String, default: null },
    at: { type: String },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

recoveryRecordSchema.index({ connectionId: 1, at: -1 });

const RecoveryRecord = mongoose.models.RecoveryRecord || mongoose.model("RecoveryRecord", recoveryRecordSchema);

export default RecoveryRecord;

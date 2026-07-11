/**
 * @module synchronization-reliability/models/SyncRecoveryRecord
 *
 * Mongoose schema for a recovery audit entry (Layer 9, Sprint 3). NEW collection; additive. Records
 * what triggered a recovery, the action taken, and its outcome — metadata only.
 */

import mongoose from "mongoose";

const syncRecoveryRecordSchema = new mongoose.Schema(
  {
    syncId: { type: String, required: true, index: true },
    trigger: { type: String },
    action: { type: String },
    outcome: { type: String },
    attempt: { type: Number, default: 1 },
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: String, index: true },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

syncRecoveryRecordSchema.index({ syncId: 1, at: -1 });

const SyncRecoveryRecord = mongoose.models.SyncRecoveryRecord || mongoose.model("SyncRecoveryRecord", syncRecoveryRecordSchema);
export default SyncRecoveryRecord;

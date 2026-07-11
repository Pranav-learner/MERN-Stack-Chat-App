/**
 * @module transport-reliability/models/RecoveryRecord
 *
 * Mongoose schema for a recovery / migration audit entry (Layer 8, Sprint 3). NEW collection;
 * additive. Records what triggered a recovery, the action taken, and its outcome — metadata only.
 */

import mongoose from "mongoose";

const recoveryRecordSchema = new mongoose.Schema(
  {
    transferId: { type: String, required: true, index: true },
    kind: { type: String, enum: ["recovery", "migration"], required: true },
    trigger: { type: String },
    action: { type: String },
    outcome: { type: String },
    attempt: { type: Number, default: 1 },
    fromConnectionId: { type: String, default: null },
    toConnectionId: { type: String, default: null },
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: String, index: true },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

recoveryRecordSchema.index({ transferId: 1, at: -1 });

const RecoveryRecord = mongoose.models.TransportRecoveryRecord || mongoose.model("TransportRecoveryRecord", recoveryRecordSchema);
export default RecoveryRecord;

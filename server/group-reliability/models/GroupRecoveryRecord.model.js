/**
 * @module group-reliability/models/GroupRecoveryRecord
 *
 * Mongoose schema for a group-operation recovery-attempt audit entry (Layer 10, Sprint 3). NEW
 * collection (`grouprecoveryrecords`); additive. Also backs the group-operation audit trail
 * (`kind: "audit"`). Metadata only — never content or keys.
 */

import mongoose from "mongoose";

const groupRecoveryRecordSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["recovery", "audit"], default: "recovery", index: true },
    operationId: { type: String, index: true },
    groupId: { type: String, index: true },
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

groupRecoveryRecordSchema.index({ kind: 1, operationId: 1, at: -1 });
groupRecoveryRecordSchema.index({ kind: 1, groupId: 1, at: -1 });

const GroupRecoveryRecord = mongoose.models.GroupRecoveryRecord || mongoose.model("GroupRecoveryRecord", groupRecoveryRecordSchema);
export default GroupRecoveryRecord;

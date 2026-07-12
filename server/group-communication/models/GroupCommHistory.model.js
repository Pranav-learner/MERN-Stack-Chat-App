/**
 * @module group-communication/models/GroupCommHistory
 *
 * Mongoose schema for the group-communication audit trail (Layer 10, Sprint 2) — key audit, delivery
 * audit, sync history, and free-form audit in ONE additive collection (`groupcommhistories`) keyed by
 * `kind`. Also backs the offline pending-delivery queue (`kind: "pending"`). Metadata only — never
 * ciphertext or keys.
 */

import mongoose from "mongoose";

const groupCommHistorySchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["key", "delivery", "sync", "audit", "pending"], required: true, index: true },
    groupId: { type: String, index: true },
    deviceId: { type: String, index: true },
    memberId: { type: String },
    messageId: { type: String },
    keyVersion: { type: Number },
    action: { type: String },
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: String, index: true },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

groupCommHistorySchema.index({ kind: 1, groupId: 1, at: -1 });
groupCommHistorySchema.index({ kind: 1, groupId: 1, deviceId: 1 });

const GroupCommHistory = mongoose.models.GroupCommHistory || mongoose.model("GroupCommHistory", groupCommHistorySchema);
export default GroupCommHistory;

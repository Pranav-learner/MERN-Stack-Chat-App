/**
 * @module group-receipts/models/GroupReceiptHistory
 *
 * Mongoose schema for the group-receipt audit trail (Layer 10, Sprint 4) — receipt-history + free-form
 * audit entries + cached analytics snapshots in ONE additive collection (`groupreceipthistories`) keyed
 * by `kind`. Metadata only — never content or keys.
 */

import mongoose from "mongoose";

const groupReceiptHistorySchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["receipt", "audit", "analytics"], required: true, index: true },
    messageId: { type: String, index: true },
    groupId: { type: String, index: true },
    memberId: { type: String },
    event: { type: String },
    tick: { type: String },
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: String, index: true },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

groupReceiptHistorySchema.index({ kind: 1, messageId: 1, at: -1 });

const GroupReceiptHistory = mongoose.models.GroupReceiptHistory || mongoose.model("GroupReceiptHistory", groupReceiptHistorySchema);
export default GroupReceiptHistory;

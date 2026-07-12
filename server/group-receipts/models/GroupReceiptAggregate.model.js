/**
 * @module group-receipts/models/GroupReceiptAggregate
 *
 * Mongoose schema for a per-message incremental receipt aggregate (Layer 10, Sprint 4). NEW collection
 * (`groupreceiptaggregates`); additive. Stores counters + latency sums + an applicable-member snapshot +
 * the computed tick — DELIVERY control-plane metadata only (no content/keys). This is the O(1) receipt
 * source of truth.
 */

import mongoose from "mongoose";

const groupReceiptAggregateSchema = new mongoose.Schema(
  {
    messageId: { type: String, required: true, unique: true, index: true },
    groupId: { type: String, required: true, index: true },
    senderId: { type: String, default: null },
    applicableMembers: { type: [String], default: [] },
    applicableCount: { type: Number, default: 0 },
    readApplicableCount: { type: Number, default: 0 },
    deliveredCount: { type: Number, default: 0 },
    readCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    deliveryLatencySumMs: { type: Number, default: 0 },
    deliveryLatencyCount: { type: Number, default: 0 },
    readLatencySumMs: { type: Number, default: 0 },
    readLatencyCount: { type: Number, default: 0 },
    fullyDeliveredAt: { type: String, default: null },
    fullyReadAt: { type: String, default: null },
    tick: { type: String, default: "single", index: true },
    policy: { type: mongoose.Schema.Types.Mixed, default: {} },
    sentAt: { type: String },
    version: { type: Number, default: 1 },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

groupReceiptAggregateSchema.index({ groupId: 1, sentAt: -1 });

const GroupReceiptAggregate = mongoose.models.GroupReceiptAggregate || mongoose.model("GroupReceiptAggregate", groupReceiptAggregateSchema);
export default GroupReceiptAggregate;

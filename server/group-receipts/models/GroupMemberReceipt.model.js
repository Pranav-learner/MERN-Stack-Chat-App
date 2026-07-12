/**
 * @module group-receipts/models/GroupMemberReceipt
 *
 * Mongoose schema for a per-(message, member) delivery + read record (Layer 10, Sprint 4). NEW
 * collection (`groupmemberreceipts`); additive. Tracks the member-level roll-up + per-device delivery/
 * read state (multi-device) — control-plane metadata only (no content/keys).
 */

import mongoose from "mongoose";

const groupMemberReceiptSchema = new mongoose.Schema(
  {
    messageId: { type: String, required: true, index: true },
    groupId: { type: String, index: true },
    memberId: { type: String, required: true, index: true },
    deliveryStatus: { type: String, default: "pending" },
    memberDelivered: { type: Boolean, default: false, index: true },
    memberRead: { type: Boolean, default: false, index: true },
    devices: { type: mongoose.Schema.Types.Mixed, default: {} },
    firstDeliveredAt: { type: String, default: null },
    firstReadAt: { type: String, default: null },
    sentAt: { type: String },
    deliveryLatencyMs: { type: Number, default: null },
    readLatencyMs: { type: Number, default: null },
    history: { type: [mongoose.Schema.Types.Mixed], default: [] },
    version: { type: Number, default: 1 },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

// One record per (message, member); fast reader / pending list scans within a message.
groupMemberReceiptSchema.index({ messageId: 1, memberId: 1 }, { unique: true });
groupMemberReceiptSchema.index({ messageId: 1, memberRead: 1 });
groupMemberReceiptSchema.index({ messageId: 1, memberDelivered: 1 });

const GroupMemberReceipt = mongoose.models.GroupMemberReceipt || mongoose.model("GroupMemberReceipt", groupMemberReceiptSchema);
export default GroupMemberReceipt;

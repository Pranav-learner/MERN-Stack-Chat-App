/**
 * @module group-communication/models/GroupFanoutPlan
 *
 * Mongoose schema for a fan-out delivery plan (Layer 10, Sprint 2). NEW collection (`groupfanoutplans`);
 * additive. Stores per-device delivery LEGS (ids + presence + priority + state) + a status roll-up —
 * never ciphertext or keys. The ciphertext travels on the Layer 8 data-plane leg, not here.
 */

import mongoose from "mongoose";

const groupFanoutPlanSchema = new mongoose.Schema(
  {
    planId: { type: String, required: true, unique: true, index: true },
    groupId: { type: String, required: true, index: true },
    messageId: { type: String, required: true, index: true },
    keyVersion: { type: Number },
    senderId: { type: String },
    status: { type: String, default: "planning", index: true },
    priority: { type: String, default: "normal" },
    legs: { type: [mongoose.Schema.Types.Mixed], default: [] },
    summary: { type: mongoose.Schema.Types.Mixed, default: {} },
    onlineCount: { type: Number, default: 0 },
    offlineCount: { type: Number, default: 0 },
    truncated: { type: Boolean, default: false },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

groupFanoutPlanSchema.index({ groupId: 1, createdAt: -1 });

const GroupFanoutPlan = mongoose.models.GroupFanoutPlan || mongoose.model("GroupFanoutPlan", groupFanoutPlanSchema);
export default GroupFanoutPlan;

/**
 * @module endpoint-selection/models/SelectionRecord
 *
 * Mongoose schema for an append-only selection/routing history record (Layer 6, Sprint 5). NEW
 * collection; additive. One record per selection event (generate / failover / refresh / reroute),
 * capturing the scoring metadata, applied policy, and routing decision for audit + observability.
 *
 * @security PUBLIC selection metadata only — scores, policy, device ids. No key material.
 */

import mongoose from "mongoose";

const selectionRecordSchema = new mongoose.Schema(
  {
    selectionId: { type: String, required: true, unique: true, index: true },
    planId: { type: String, index: true },
    requester: { type: String, required: true, index: true },
    targetUser: { type: String, required: true, index: true },
    action: { type: String, index: true }, // generate | failover | refresh | reroute
    selectionPolicy: { type: String },
    weights: { type: mongoose.Schema.Types.Mixed, default: {} },
    primaryDeviceId: { type: String, default: null },
    priorityOrder: { type: [String], default: [] },
    // Per-endpoint ranking + score breakdown (scoring metadata).
    ranking: { type: [mongoose.Schema.Types.Mixed], default: [] },
    reason: { type: String },
    at: { type: String },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

selectionRecordSchema.index({ requester: 1, at: -1 });
selectionRecordSchema.index({ requester: 1, targetUser: 1, at: -1 });

const SelectionRecord =
  mongoose.models.SelectionRecord || mongoose.model("SelectionRecord", selectionRecordSchema);

export default SelectionRecord;

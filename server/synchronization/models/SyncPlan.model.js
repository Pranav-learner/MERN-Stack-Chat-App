/**
 * @module synchronization/models/SyncPlan
 *
 * Mongoose schema for a deterministic synchronization PLAN (Layer 9, Sprint 1). NEW collection;
 * additive. Stores operation summaries + a determinism hash — entity refs (ids + versions) only.
 */

import mongoose from "mongoose";

const syncPlanSchema = new mongoose.Schema(
  {
    planId: { type: String, required: true, unique: true, index: true },
    sessionId: { type: String, required: true, index: true },
    operations: { type: mongoose.Schema.Types.Mixed, default: [] },
    ordering: { type: [String], default: [] },
    totalOperations: { type: Number, default: 0 },
    totalItems: { type: Number, default: 0 },
    plannedItems: { type: Number, default: 0 },
    remainingItems: { type: Number, default: 0 },
    partial: { type: Boolean, default: false },
    batchSize: { type: Number, default: 100 },
    estimatedBytes: { type: Number, default: 0 },
    deterministicHash: { type: String },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

const SyncPlan = mongoose.models.SyncPlan || mongoose.model("SyncPlan", syncPlanSchema);
export default SyncPlan;

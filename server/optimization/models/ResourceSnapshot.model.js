/**
 * @module optimization/models/ResourceSnapshot
 *
 * Persisted **Resource Snapshot** — a point-in-time record of the global budgets (total/allocated/
 * available/utilization per kind) + which resources were constrained. Retained for optimization history +
 * (Sprint 4) monitoring. Control-plane only: abstract budget numbers. No content/keys.
 */

import mongoose from "mongoose";

const ResourceSnapshotSchema = new mongoose.Schema(
  {
    budgets: { type: mongoose.Schema.Types.Mixed, default: {} },
    constrained: { type: [String], default: [] },
    reservations: { type: Number, default: 0 },
    at: { type: String },
  },
  { timestamps: true, minimize: false },
);

export const ResourceSnapshotModel = mongoose.models.OptimizationResourceSnapshot || mongoose.model("OptimizationResourceSnapshot", ResourceSnapshotSchema);
export default ResourceSnapshotModel;

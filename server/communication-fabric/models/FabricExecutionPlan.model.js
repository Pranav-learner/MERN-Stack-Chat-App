/**
 * @module communication-fabric/models/FabricExecutionPlan
 *
 * Persisted **Execution Plan + Execution result** — the ordered steps the Fabric built for a decision and
 * the outcome of running them (status, per-step ledger, timing). Retained for diagnostics + audit.
 * Control-plane only: subsystem/action/route/status. Step params are opaque refs; no content/keys.
 */

import mongoose from "mongoose";

const StepSchema = new mongoose.Schema(
  {
    stepId: String,
    subsystem: String,
    action: String,
    route: String,
    required: Boolean,
    dependsOn: { type: [String], default: [] },
    status: String,
    viaFallback: String,
    error: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const FabricExecutionPlanSchema = new mongoose.Schema(
  {
    planId: { type: String, required: true, unique: true, index: true },
    requestId: { type: String, required: true, index: true },
    decisionId: { type: String, required: true, index: true },
    strategyType: { type: String, index: true },
    steps: { type: [StepSchema], default: [] },
    routing: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, default: "planned", index: true },
    durationMs: { type: Number, default: null },
    startedAt: { type: String, default: null },
    finishedAt: { type: String, default: null },
    schemaVersion: { type: Number, default: 1 },
    createdAt: { type: String },
  },
  { timestamps: true, minimize: false },
);

export const FabricExecutionPlanModel = mongoose.models.FabricExecutionPlan || mongoose.model("FabricExecutionPlan", FabricExecutionPlanSchema);
export default FabricExecutionPlanModel;

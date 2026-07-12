/**
 * @module communication-fabric/models/FabricDecision
 *
 * Persisted **Communication Decision** — the "how" the Decision Engine chose for a request, retained for
 * diagnostics, audit, and (Sprint 2) adaptive learning. Control-plane only: strategy + route + subsystem
 * ordering + reasons + policy refs + constraints. No content/keys.
 */

import mongoose from "mongoose";

const ReasonSchema = new mongoose.Schema({ rule: String, effect: String, note: String }, { _id: false });

const FabricDecisionSchema = new mongoose.Schema(
  {
    decisionId: { type: String, required: true, unique: true, index: true },
    requestId: { type: String, required: true, index: true },
    strategyType: { type: String, required: true, index: true },
    primaryRoute: { type: String, required: true },
    subsystems: { type: [String], default: [] },
    confidence: { type: String, default: "likely" },
    reasons: { type: [ReasonSchema], default: [] },
    policyRefs: { type: [String], default: [] },
    constraints: { type: mongoose.Schema.Types.Mixed, default: {} },
    scoring: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, default: 1 },
    createdAt: { type: String },
  },
  { timestamps: true, minimize: false },
);

export const FabricDecisionModel = mongoose.models.FabricDecision || mongoose.model("FabricDecision", FabricDecisionSchema);
export default FabricDecisionModel;

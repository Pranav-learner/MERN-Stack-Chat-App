/**
 * @module adaptive-routing/models/RouteEvaluation
 *
 * Persisted **Route Evaluation** — the bundled result of one adaptive evaluation: the communication
 * analysis, the ranked route scores, the selection, the fallback plan, the execution plan reference, and
 * the applied policy refs. One document is the single addressable record for "how was this request
 * routed and why". Control-plane only: classifications + scores + route/strategy ids. No content/keys.
 */

import mongoose from "mongoose";

const RouteScoreSchema = new mongoose.Schema(
  { strategyType: String, routeKind: String, total: Number, viable: Boolean, rank: Number, breakdown: { type: mongoose.Schema.Types.Mixed, default: {} }, adaptive: Boolean },
  { _id: false },
);

const RouteEvaluationSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, index: true },
    senderId: { type: String, default: null, index: true },
    analysis: { type: mongoose.Schema.Types.Mixed, default: {} },
    network: { type: mongoose.Schema.Types.Mixed, default: {} },
    capabilityFingerprint: { type: String, default: null },
    ranked: { type: [RouteScoreSchema], default: [] },
    selection: { type: mongoose.Schema.Types.Mixed, default: {} },
    fallbackPlan: { type: mongoose.Schema.Types.Mixed, default: {} },
    executionPlan: { type: mongoose.Schema.Types.Mixed, default: null },
    policyRefs: { type: [String], default: [] },
    explanation: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, default: 1 },
    createdAt: { type: String },
  },
  { timestamps: true, minimize: false },
);

RouteEvaluationSchema.index({ requestId: 1, createdAt: -1 });

export const RouteEvaluationModel = mongoose.models.AdaptiveRouteEvaluation || mongoose.model("AdaptiveRouteEvaluation", RouteEvaluationSchema);
export default RouteEvaluationModel;

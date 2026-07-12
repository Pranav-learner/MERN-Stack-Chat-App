/**
 * @module optimization/models/OptimizationRecord
 *
 * Persisted **Optimization Record** — the bundled result of one optimization: the QoS decision, the
 * scheduling decision, the resource allocation, the cross-device coordination plan, the balance snapshot,
 * and the optimized execution plan. One document is the single addressable record for "how was this
 * communication globally optimized". Control-plane only: classifications + budgets + queue numbers +
 * offsets. No content/keys.
 */

import mongoose from "mongoose";

const OptimizationRecordSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, index: true },
    senderId: { type: String, default: null, index: true },
    qos: { type: mongoose.Schema.Types.Mixed, default: {} },
    scheduling: { type: mongoose.Schema.Types.Mixed, default: {} },
    allocation: { type: mongoose.Schema.Types.Mixed, default: null },
    coordination: { type: mongoose.Schema.Types.Mixed, default: null },
    balance: { type: mongoose.Schema.Types.Mixed, default: null },
    optimizedPlan: { type: mongoose.Schema.Types.Mixed, default: {} },
    cost: { type: mongoose.Schema.Types.Mixed, default: null },
    status: { type: String, default: null, index: true },
    proceed: { type: Boolean, default: null },
    schemaVersion: { type: Number, default: 1 },
    createdAt: { type: String },
  },
  { timestamps: true, minimize: false },
);

OptimizationRecordSchema.index({ requestId: 1, createdAt: -1 });

export const OptimizationRecordModel = mongoose.models.OptimizationRecord || mongoose.model("OptimizationRecord", OptimizationRecordSchema);
export default OptimizationRecordModel;

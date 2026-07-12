/**
 * @module optimization/models/OptimizationAuditLog
 *
 * Persisted **optimization audit trail** — one row per notable stage (resources collected, QoS evaluated,
 * scheduled/deferred, resources allocated, devices coordinated, workload balanced, completed) for a
 * request. Feeds optimization history + Sprint-4 monitoring. Control-plane only: event type + ids +
 * classifications + numbers. No content/keys.
 */

import mongoose from "mongoose";

const OptimizationAuditLogSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, index: true },
    event: { type: String, required: true, index: true },
    qosClass: { type: String, default: null },
    mode: { type: String, default: null },
    status: { type: String, default: null },
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: String },
  },
  { timestamps: true, minimize: false },
);

OptimizationAuditLogSchema.index({ requestId: 1, createdAt: 1 });

export const OptimizationAuditLogModel = mongoose.models.OptimizationAuditLog || mongoose.model("OptimizationAuditLog", OptimizationAuditLogSchema);
export default OptimizationAuditLogModel;

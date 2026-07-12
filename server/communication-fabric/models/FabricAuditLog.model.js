/**
 * @module communication-fabric/models/FabricAuditLog
 *
 * Persisted **Fabric audit trail** — one row per notable lifecycle event (requested, context built,
 * decision created, strategy selected, execution planned/started/completed/failed) for a request. Feeds
 * observability + Sprint-2 adaptive learning. Control-plane only: event type + ids + classifications +
 * error codes. No content/keys.
 */

import mongoose from "mongoose";

const FabricAuditLogSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, index: true },
    event: { type: String, required: true, index: true },
    strategyType: { type: String, default: null },
    route: { type: String, default: null },
    status: { type: String, default: null },
    code: { type: String, default: null },
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: String },
  },
  { timestamps: true, minimize: false },
);

FabricAuditLogSchema.index({ requestId: 1, createdAt: 1 });

export const FabricAuditLogModel = mongoose.models.FabricAuditLog || mongoose.model("FabricAuditLog", FabricAuditLogSchema);
export default FabricAuditLogModel;

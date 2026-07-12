/**
 * @module fabric-reliability/models/FabricReliabilityAuditLog
 *
 * Persisted **reliability audit trail** — one row per notable reliability + security event (operation
 * started/succeeded/failed, retry, circuit transition, recovery, security-audit) for an operation. This is
 * the tamper-evident record of every orchestration decision (STEP 7). Control-plane only: event type + ids
 * + classifications + numbers. No content/keys.
 */

import mongoose from "mongoose";

const FabricReliabilityAuditLogSchema = new mongoose.Schema(
  {
    operationId: { type: String, default: null, index: true },
    event: { type: String, required: true, index: true },
    kind: { type: String, default: null },
    callerId: { type: String, default: null },
    decision: { type: String, default: null },
    reason: { type: String, default: null },
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: String },
  },
  { timestamps: true, minimize: false },
);

FabricReliabilityAuditLogSchema.index({ operationId: 1, createdAt: 1 });

export const FabricReliabilityAuditLogModel = mongoose.models.FabricReliabilityAuditLog || mongoose.model("FabricReliabilityAuditLog", FabricReliabilityAuditLogSchema);
export default FabricReliabilityAuditLogModel;

/**
 * @module adaptive-routing/models/AdaptiveAuditLog
 *
 * Persisted **adaptive audit trail** — one row per notable stage (capabilities collected, analyzed,
 * scored, selected, fallback generated, explained) for a request. Feeds observability + Sprint-3 resource
 * optimization. Control-plane only: event type + ids + classifications + scores. No content/keys.
 */

import mongoose from "mongoose";

const AdaptiveAuditLogSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, index: true },
    event: { type: String, required: true, index: true },
    strategy: { type: String, default: null },
    route: { type: String, default: null },
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: String },
  },
  { timestamps: true, minimize: false },
);

AdaptiveAuditLogSchema.index({ requestId: 1, createdAt: 1 });

export const AdaptiveAuditLogModel = mongoose.models.AdaptiveAuditLog || mongoose.model("AdaptiveAuditLog", AdaptiveAuditLogSchema);
export default AdaptiveAuditLogModel;

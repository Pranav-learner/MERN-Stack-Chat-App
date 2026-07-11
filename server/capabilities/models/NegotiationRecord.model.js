/**
 * @module capabilities/models/NegotiationRecord
 *
 * Mongoose schema for a capability-negotiation history record (Layer 6, Sprint 3). NEW collection;
 * additive. Stores the deterministic OUTCOME of negotiating two devices' capability sets — the
 * compatibility + preferred-transport plan — for audit + observability. It records a plan, never a
 * connection.
 *
 * @security Stores PUBLIC negotiation results only — versions, transport names, feature flags. No
 * key material.
 */

import mongoose from "mongoose";

const negotiationRecordSchema = new mongoose.Schema(
  {
    negotiationId: { type: String, required: true, unique: true, index: true },
    requester: { type: String, required: true, index: true },
    requesterDevice: { type: String, required: true },
    targetUser: { type: String, required: true, index: true },
    targetDevice: { type: String, required: true },
    state: { type: String, enum: ["pending", "negotiating", "succeeded", "failed"], required: true, index: true },
    // The PUBLIC negotiation result (compatibility + preferred transport plan) — no key material.
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt: { type: String },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

// Fast per-device + per-pair history lookups.
negotiationRecordSchema.index({ requester: 1, requesterDevice: 1, createdAt: -1 });
negotiationRecordSchema.index({ targetUser: 1, targetDevice: 1, createdAt: -1 });

const NegotiationRecord =
  mongoose.models.NegotiationRecord || mongoose.model("NegotiationRecord", negotiationRecordSchema);

export default NegotiationRecord;

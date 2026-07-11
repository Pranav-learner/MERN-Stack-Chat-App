/**
 * @module pdp/models/PdpSession
 *
 * Mongoose schema for a Peer-Discovery-Protocol session (Layer 6, Sprint 4). NEW collection;
 * additive — it does NOT modify existing schemas. Tracks one discovery-protocol run's workflow.
 *
 * @security Stores PDP CONTROL-PLANE metadata ONLY — ids, state, stage, audit. It references a
 * connection plan by id; there is deliberately **NO field** for a private key, session key, or
 * shared secret, and no transport reachability (Layer 7).
 */

import mongoose from "mongoose";

const pdpSessionSchema = new mongoose.Schema(
  {
    discoveryId: { type: String, required: true, unique: true, index: true },
    requester: { type: String, required: true, index: true },
    requesterDevice: { type: String, required: true },
    targetUser: { type: String, required: true, index: true },
    targetDevices: { type: [String], default: [] },
    selectionPolicy: { type: String, default: "capability-score" },
    state: {
      type: String,
      enum: ["created", "resolving", "negotiating", "planning", "completed", "failed", "cancelled", "expired", "recovery"],
      required: true,
      index: true,
    },
    stage: { type: String, default: null },
    planId: { type: String, default: null, index: true },
    dedupeKey: { type: String, index: true },
    failureReason: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    requestTime: { type: String },
    expiresAt: { type: String, index: true },
    completedAt: { type: String, default: null },
    stageHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },
    audit: { type: [mongoose.Schema.Types.Mixed], default: [] },
    history: { type: [mongoose.Schema.Types.Mixed], default: [] },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

pdpSessionSchema.index({ state: 1, expiresAt: 1 });
pdpSessionSchema.index({ requester: 1, state: 1 });
pdpSessionSchema.index({ dedupeKey: 1, state: 1 });

const PdpSession = mongoose.models.PdpSession || mongoose.model("PdpSession", pdpSessionSchema);

export default PdpSession;

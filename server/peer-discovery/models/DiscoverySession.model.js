/**
 * @module peer-discovery/models/DiscoverySession
 *
 * Mongoose schema for a discovery-session record (Layer 6, Sprint 1). NEW collection;
 * additive — it does NOT modify the existing User/Message/Group or any crypto-subsystem
 * schema.
 *
 * @security This collection stores discovery CONTROL-PLANE metadata ONLY — requester +
 * target ids, lifecycle state, a resolved result of PUBLIC device/identity descriptors,
 * and audit. There is deliberately **NO field** for a private key, session key, message
 * key, chain key, or shared secret. The `result` sub-document carries public device keys
 * + fingerprints only.
 */

import mongoose from "mongoose";

const discoverySessionSchema = new mongoose.Schema(
  {
    discoveryId: { type: String, required: true, unique: true, index: true },
    requester: { type: String, required: true, index: true },
    requesterDevice: { type: String },
    targetUser: { type: String, required: true, index: true },
    targetDevices: { type: [String], default: [] },
    lookupType: { type: String, enum: ["user", "device", "devices"], required: true },
    state: {
      type: String,
      enum: ["created", "pending", "searching", "resolved", "failed", "expired", "cancelled", "completed"],
      required: true,
      index: true,
    },
    // A denormalized dedupe key so an in-flight duplicate can be found with one indexed query.
    dedupeKey: { type: String, index: true },
    requestTime: { type: String },
    expiresAt: { type: String, index: true },
    resolvedAt: { type: String, default: null },
    completedAt: { type: String, default: null },
    // Resolved metadata (PUBLIC descriptors only) — stored as Mixed so the framework owns its shape.
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    capabilitiesSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    failureReason: { type: String, default: null },
    audit: { type: [mongoose.Schema.Types.Mixed], default: [] },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    history: { type: [mongoose.Schema.Types.Mixed], default: [] },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

// Compound index accelerates "active sessions past their TTL" sweeps and per-requester lists.
discoverySessionSchema.index({ state: 1, expiresAt: 1 });
discoverySessionSchema.index({ requester: 1, state: 1 });

const DiscoverySession =
  mongoose.models.DiscoverySession || mongoose.model("DiscoverySession", discoverySessionSchema);

export default DiscoverySession;

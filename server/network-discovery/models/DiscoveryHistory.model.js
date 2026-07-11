/**
 * @module network-discovery/models/DiscoveryHistory
 *
 * Mongoose schema for an append-only network-discovery history record (Layer 7, Sprint 1). NEW
 * collection; additive. One record per discovery/refresh, capturing a compact snapshot for
 * diagnostics + network-change tracking.
 *
 * @security PUBLIC addressing metadata only — no key material.
 */

import mongoose from "mongoose";

const discoveryHistorySchema = new mongoose.Schema(
  {
    profileId: { type: String, index: true },
    deviceId: { type: String, required: true, index: true },
    action: { type: String, index: true }, // generate | refresh | expire
    natType: { type: String },
    publicAddress: { type: String, default: null },
    candidateCount: { type: Number, default: 0 },
    signature: { type: String },
    changed: { type: Boolean, default: false },
    diagnostics: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: String },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

discoveryHistorySchema.index({ deviceId: 1, at: -1 });

const DiscoveryHistory = mongoose.models.DiscoveryHistory || mongoose.model("DiscoveryHistory", discoveryHistorySchema);

export default DiscoveryHistory;

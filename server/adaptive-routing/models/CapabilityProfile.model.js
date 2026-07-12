/**
 * @module adaptive-routing/models/CapabilityProfile
 *
 * Persisted negotiated **Capability Profile** — retained (and de-duplicated by fingerprint) so the engine
 * can reuse a party's negotiated capabilities across evaluations and a dashboard can inspect them. Control-
 * plane only: versions + declared transport/media/feature ids. No content/keys.
 */

import mongoose from "mongoose";

const CapabilityProfileSchema = new mongoose.Schema(
  {
    fingerprint: { type: String, required: true, unique: true, index: true },
    identityId: { type: String, default: null, index: true },
    deviceId: { type: String, default: null },
    appVersion: { type: Number, default: 1 },
    protocolVersion: { type: Number, default: 1 },
    transports: { type: [String], default: [] },
    media: { type: [String], default: [] },
    features: { type: [String], default: [] },
    codecs: { type: [String], default: [] },
    collectedAt: { type: String },
  },
  { timestamps: true, minimize: false },
);

export const CapabilityProfileModel = mongoose.models.AdaptiveCapabilityProfile || mongoose.model("AdaptiveCapabilityProfile", CapabilityProfileSchema);
export default CapabilityProfileModel;

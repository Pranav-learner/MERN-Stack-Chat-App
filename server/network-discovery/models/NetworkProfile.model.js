/**
 * @module network-discovery/models/NetworkProfile
 *
 * Mongoose schema for a device network profile (Layer 7, Sprint 1). NEW collection; additive. One
 * current profile per device (candidates embedded).
 *
 * @security Stores PUBLIC network addressing metadata ONLY — private/public IPs + ports, NAT type,
 * interfaces, ICE-style candidates, diagnostics. There is deliberately **NO field** for a private
 * key, session key, message key, chain key, or shared secret.
 */

import mongoose from "mongoose";

const networkProfileSchema = new mongoose.Schema(
  {
    profileId: { type: String, required: true, unique: true, index: true },
    framework: { type: String },
    deviceId: { type: String, required: true, index: true },
    userId: { type: String, default: null, index: true },
    state: { type: String, enum: ["discovering", "ready", "expired", "stale", "failed"], default: "ready", index: true },
    privateAddresses: { type: [String], default: [] },
    publicAddress: { type: String, default: null },
    privatePorts: { type: [Number], default: [] },
    publicPorts: { type: [Number], default: [] },
    natType: { type: String, enum: ["no-nat", "cone", "symmetric", "blocked", "unknown"], default: "unknown", index: true },
    interfaces: { type: [mongoose.Schema.Types.Mixed], default: [] },
    candidates: { type: [mongoose.Schema.Types.Mixed], default: [] },
    connectionMetadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    nat: { type: mongoose.Schema.Types.Mixed, default: {} },
    diagnostics: { type: mongoose.Schema.Types.Mixed, default: {} },
    discoveredAt: { type: String },
    expiresAt: { type: String, index: true },
    version: { type: Number, default: 1 },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

networkProfileSchema.index({ deviceId: 1, state: 1 });
networkProfileSchema.index({ state: 1, expiresAt: 1 });

const NetworkProfile = mongoose.models.NetworkProfile || mongoose.model("NetworkProfile", networkProfileSchema);

export default NetworkProfile;

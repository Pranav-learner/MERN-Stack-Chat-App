/**
 * @module capabilities/models/CapabilitySet
 *
 * Mongoose schema for a device's capability set (Layer 6, Sprint 3). NEW collection; additive — it
 * does NOT modify the existing User/Message/Group, identity/device, discovery, presence, or any
 * crypto-subsystem schema. One document per `(userId, deviceId)`.
 *
 * @security This collection stores capability CONTROL-PLANE metadata ONLY — ids, versions,
 * transport names, compression algorithms, feature flags, limits. There is deliberately **NO
 * field** for a private key, session key, message key, chain key, or shared secret, and **no
 * transport reachability** (a future sprint).
 */

import mongoose from "mongoose";

const capabilitySetSchema = new mongoose.Schema(
  {
    capabilityId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    identityId: { type: String, default: null, index: true },
    deviceId: { type: String, required: true, index: true },
    protocolVersions: { type: [String], default: [] },
    cryptoVersions: { type: [String], default: [] },
    transports: { type: [String], default: [] },
    compression: { type: [String], default: [] },
    attachments: { type: mongoose.Schema.Types.Mixed, default: { supported: false, maxSize: 0 } },
    maxPayloadSize: { type: Number, default: 0 },
    relaySupport: { type: Boolean, default: false },
    // FUTURE placeholder — inert P2P block (NAT/WebRTC sprints populate it).
    p2p: { type: mongoose.Schema.Types.Mixed, default: {} },
    connectionPreferences: { type: [String], default: [] },
    platformFeatures: { type: [String], default: [] },
    softwareVersion: { type: String },
    featureFlags: { type: mongoose.Schema.Types.Mixed, default: {} },
    state: {
      type: String,
      enum: ["registered", "advertised", "expired", "removed"],
      required: true,
      index: true,
    },
    version: { type: Number, default: 1 },
    registeredAt: { type: String },
    expiresAt: { type: String, index: true },
    versionHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

// One capability set per (user, device); primary lookups are by device + by user.
capabilitySetSchema.index({ userId: 1, deviceId: 1 }, { unique: true });
// Accelerates state listings + TTL-expiry sweeps.
capabilitySetSchema.index({ state: 1, expiresAt: 1 });

const CapabilitySet =
  mongoose.models.CapabilitySet || mongoose.model("CapabilitySet", capabilitySetSchema);

export default CapabilitySet;

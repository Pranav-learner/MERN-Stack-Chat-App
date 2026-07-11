/**
 * @module peer-discovery/models/DiscoveryRegistryEntry
 *
 * Mongoose schema for a discoverable device descriptor in the discovery registry (Layer
 * 6, Sprint 1). NEW collection; additive. One document per (userId, deviceId).
 *
 * @security Stores the device's PUBLIC key + fingerprint ONLY, plus inert
 * presence/capability/transport placeholders. There is deliberately **NO field** for a
 * private key or any shared secret. This is a discovery directory, not a key store.
 */

import mongoose from "mongoose";

const discoveryRegistryEntrySchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    identityId: { type: String, index: true },
    deviceId: { type: String, required: true, index: true },
    publicKey: { type: String, required: true }, // PUBLIC device key only
    algorithm: { type: String, default: "ed25519" },
    fingerprint: { type: String, index: true },
    name: { type: String },
    platform: { type: String },
    status: { type: String, enum: ["active", "inactive", "revoked"], default: "active", index: true },
    // FUTURE placeholders — inert until later Layer 6 sprints populate them.
    presence: { type: mongoose.Schema.Types.Mixed, default: {} },
    capabilities: { type: mongoose.Schema.Types.Mixed, default: {} },
    transport: { type: mongoose.Schema.Types.Mixed, default: {} },
    version: { type: Number, default: 1 },
    registeredAt: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

// One descriptor per (user, device); primary lookup is by user.
discoveryRegistryEntrySchema.index({ userId: 1, deviceId: 1 }, { unique: true });

const DiscoveryRegistryEntry =
  mongoose.models.DiscoveryRegistryEntry ||
  mongoose.model("DiscoveryRegistryEntry", discoveryRegistryEntrySchema);

export default DiscoveryRegistryEntry;

/**
 * @module pdp/models/ConnectionPlan
 *
 * Mongoose schema for a connection plan (Layer 6, Sprint 4) — the PRIMARY OUTPUT of PDP. NEW
 * collection; additive. One plan per successful discovery run.
 *
 * @security A connection plan is PUBLIC — selected device ids, public identities, presence status,
 * negotiated versions/transports/flags. There is deliberately **NO field** for a private key,
 * session key, message key, chain key, or shared secret, and **no transport reachability** (the
 * `connection` + `nat` blocks are inert placeholders Layer 7 fills).
 */

import mongoose from "mongoose";

const connectionPlanSchema = new mongoose.Schema(
  {
    planId: { type: String, required: true, unique: true, index: true },
    discoveryId: { type: String, required: true, index: true },
    protocol: { type: String },
    requester: { type: String, required: true, index: true },
    requesterDevice: { type: String, required: true },
    targetUser: { type: String, required: true, index: true },
    // Selected devices + presence snapshot + negotiated capabilities — PUBLIC descriptors only.
    selectedDevices: { type: [mongoose.Schema.Types.Mixed], default: [] },
    primaryDeviceId: { type: String, default: null },
    presenceSnapshot: { type: [mongoose.Schema.Types.Mixed], default: [] },
    negotiatedCapabilities: { type: mongoose.Schema.Types.Mixed, default: null },
    preferredTransport: { type: String, default: null },
    fallbackTransports: { type: [String], default: [] },
    protocolVersion: { type: String, default: null },
    cryptoVersion: { type: String, default: null },
    cryptoCompatible: { type: Boolean, default: false },
    priority: { type: Number, default: 0 },
    selectionPolicy: { type: String },
    // FUTURE placeholders — Layer 7 (NAT / ICE / WebRTC) fills these.
    connection: { type: mongoose.Schema.Types.Mixed, default: {} },
    nat: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: String },
    expiresAt: { type: String, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

connectionPlanSchema.index({ requester: 1, createdAt: -1 });

const ConnectionPlan = mongoose.models.ConnectionPlan || mongoose.model("ConnectionPlan", connectionPlanSchema);

export default ConnectionPlan;

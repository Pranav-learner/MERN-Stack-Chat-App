/**
 * @module endpoint-selection/models/EndpointConnectionPlan
 *
 * Mongoose schema for an optimized endpoint connection plan (Layer 6, Sprint 5). NEW collection;
 * additive — it does NOT modify existing schemas (including the Sprint 4 PDP `connectionplans`).
 *
 * @security A plan is PUBLIC — endpoint device ids, public identities, presence status, negotiated
 * versions/transports/flags, scores. There is deliberately **NO field** for a private key, session
 * key, message key, chain key, or shared secret, and **no transport reachability** (`nat` is an
 * inert placeholder Layer 7 fills).
 */

import mongoose from "mongoose";

const endpointConnectionPlanSchema = new mongoose.Schema(
  {
    planId: { type: String, required: true, unique: true, index: true },
    framework: { type: String },
    requester: { type: String, required: true, index: true },
    requesterDevice: { type: String, required: true },
    targetUser: { type: String, required: true, index: true },
    status: { type: String, enum: ["active", "failed-over", "expired", "exhausted", "superseded"], default: "active", index: true },
    primaryEndpoint: { type: mongoose.Schema.Types.Mixed, default: null },
    fallbackEndpoints: { type: [mongoose.Schema.Types.Mixed], default: [] },
    priorityOrder: { type: [String], default: [] },
    selectionReason: { type: String },
    negotiatedCapabilities: { type: mongoose.Schema.Types.Mixed, default: null },
    preferredTransport: { type: String, default: null },
    fallbackTransports: { type: [String], default: [] },
    retryStrategy: { type: mongoose.Schema.Types.Mixed, default: {} },
    selectionPolicy: { type: String },
    weights: { type: mongoose.Schema.Types.Mixed, default: {} },
    nat: { type: mongoose.Schema.Types.Mixed, default: {} }, // FUTURE — inert
    priority: { type: Number, default: 0 },
    generation: { type: Number, default: 0 },
    createdAt: { type: String },
    expiresAt: { type: String, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

endpointConnectionPlanSchema.index({ requester: 1, createdAt: -1 });

const EndpointConnectionPlan =
  mongoose.models.EndpointConnectionPlan || mongoose.model("EndpointConnectionPlan", endpointConnectionPlanSchema);

export default EndpointConnectionPlan;

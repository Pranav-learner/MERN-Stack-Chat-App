/**
 * @module network-reliability/models/ActiveConnection
 *
 * Mongoose schema for an active connection record (Layer 7, Sprint 3) — the reliability layer's view
 * of a connection produced by Sprint 2. NEW collection; additive.
 *
 * @security Stores connection CONTROL-PLANE metadata ONLY — ids, state, transport, health metrics,
 * the crypto `sessionId` (an id, NOT a key). There is deliberately **NO field** for a private key,
 * session key, message key, chain key, or shared secret, and no message content.
 */

import mongoose from "mongoose";

const activeConnectionSchema = new mongoose.Schema(
  {
    connectionId: { type: String, required: true, unique: true, index: true },
    deviceId: { type: String, required: true, index: true },
    peerId: { type: String, required: true, index: true },
    sessionId: { type: String, default: null }, // crypto session id (preserved across reconnect) — NOT a key
    planId: { type: String, default: null },
    state: {
      type: String,
      enum: ["new", "connecting", "connected", "degraded", "reconnecting", "recovering", "disconnected", "failed", "closed"],
      required: true,
      index: true,
    },
    transport: { type: String, enum: ["host", "srflx", "relay", "unknown"], default: "unknown" },
    relayUsed: { type: Boolean, default: false },
    selectedPair: { type: mongoose.Schema.Types.Mixed, default: null },
    health: { type: mongoose.Schema.Types.Mixed, default: {} },
    reconnectCount: { type: Number, default: 0 },
    recoveryCount: { type: Number, default: 0 },
    retryPolicy: { type: mongoose.Schema.Types.Mixed, default: {} },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    establishedAt: { type: String },
    lastActivityAt: { type: String },
    heartbeatExpiresAt: { type: String, index: true },
    version: { type: Number, default: 1 },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

activeConnectionSchema.index({ deviceId: 1, peerId: 1 }, { unique: true });
activeConnectionSchema.index({ state: 1, heartbeatExpiresAt: 1 });

const ActiveConnection = mongoose.models.ActiveConnection || mongoose.model("ActiveConnection", activeConnectionSchema);

export default ActiveConnection;

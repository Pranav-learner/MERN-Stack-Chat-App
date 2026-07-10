/**
 * @module shs/models/HandshakeSession
 *
 * Mongoose schema for a handshake session (Layer 4, Sprint 1). NEW collection;
 * additive — it does not touch any existing schema.
 *
 * @security Stores PUBLIC lifecycle metadata ONLY. There is deliberately no field
 * for a shared secret, session key, or any private material — those belong to
 * future sprints and, when added, will store PUBLIC negotiation artifacts here
 * while private keys stay on-device.
 */

import mongoose from "mongoose";

const historyEntrySchema = new mongoose.Schema(
  {
    from: { type: String, default: null },
    to: { type: String, required: true },
    at: { type: String, required: true },
    reason: { type: String },
  },
  { _id: false },
);

const handshakeSessionSchema = new mongoose.Schema(
  {
    handshakeId: { type: String, required: true, unique: true, index: true },
    initiator: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    responder: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    initiatorDevice: { type: String, required: true },
    responderDevice: { type: String },
    protocolVersion: { type: String, required: true },
    minVersion: { type: String, required: true },
    state: {
      type: String,
      enum: [
        "created",
        "initialized",
        "waiting",
        "negotiating",
        "completed",
        "failed",
        "cancelled",
        "expired",
        "timed_out",
        "rejected",
        "aborted",
      ],
      required: true,
      index: true,
    },
    proposedCapabilities: { type: [String], default: [] },
    negotiatedCapabilities: { type: [String], default: [] },
    retryCount: { type: Number, default: 0 },
    previousHandshakeId: { type: String },
    reason: { type: String },
    terminatedBy: { type: String, enum: ["initiator", "responder", "system"] },
    history: { type: [historyEntrySchema], default: [] },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    expiresAt: { type: String },
    completedAt: { type: String },
  },
  { timestamps: true },
);

// Fast lookup of the live handshake between a pair (see repository.findActiveByPair).
handshakeSessionSchema.index({ initiator: 1, responder: 1, state: 1 });

const HandshakeSession =
  mongoose.models.HandshakeSession || mongoose.model("HandshakeSession", handshakeSessionSchema);

export default HandshakeSession;

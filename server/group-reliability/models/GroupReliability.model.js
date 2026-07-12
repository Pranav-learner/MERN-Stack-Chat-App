/**
 * @module group-reliability/models/GroupReliability
 *
 * Mongoose schema for a group-operation reliability record (Layer 10, Sprint 3). NEW collection
 * (`groupreliabilities`); additive. Stores reliability state + monotonic checkpoint + health + recovery
 * counters — CONTROL-PLANE metadata only (no message content or keys).
 */

import mongoose from "mongoose";

const groupReliabilitySchema = new mongoose.Schema(
  {
    operationId: { type: String, required: true, unique: true, index: true },
    groupId: { type: String, required: true, index: true },
    operationType: { type: String, required: true, index: true },
    deviceId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    state: { type: String, default: "tracking", index: true },
    checkpoint: { type: mongoose.Schema.Types.Mixed, default: {} },
    health: { type: mongoose.Schema.Types.Mixed, default: {} },
    keyVersion: { type: Number, default: null },
    recoveryCount: { type: Number, default: 0 },
    resumeCount: { type: Number, default: 0 },
    retryCount: { type: Number, default: 0 },
    retryPolicy: { type: mongoose.Schema.Types.Mixed, default: {} },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    failureReason: { type: String, default: null },
    registeredAt: { type: String },
    lastActivityAt: { type: String, index: true },
    expiresAt: { type: String, index: true },
    version: { type: Number, default: 1 },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

groupReliabilitySchema.index({ groupId: 1, state: 1 });
groupReliabilitySchema.index({ userId: 1, state: 1 });
groupReliabilitySchema.index({ state: 1, lastActivityAt: 1 });

const GroupReliability = mongoose.models.GroupReliability || mongoose.model("GroupReliability", groupReliabilitySchema);
export default GroupReliability;

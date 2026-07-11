/**
 * @module endpoint-selection/models/EndpointReliability
 *
 * Mongoose schema for per-(targetUser, deviceId) historical reliability (Layer 6, Sprint 5). NEW
 * collection; additive. Feeds the RELIABILITY scoring dimension — devices that have historically
 * connected successfully score higher.
 *
 * @security PUBLIC counters only (successes/failures/last outcome). No key material, no message
 * content — just whether a connection *attempt* succeeded.
 */

import mongoose from "mongoose";

const endpointReliabilitySchema = new mongoose.Schema(
  {
    targetUser: { type: String, required: true, index: true },
    deviceId: { type: String, required: true, index: true },
    successes: { type: Number, default: 0 },
    failures: { type: Number, default: 0 },
    lastOutcome: { type: String, default: null },
    lastOutcomeAt: { type: String, default: null },
    reliability: { type: Number, default: 0.5 },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

endpointReliabilitySchema.index({ targetUser: 1, deviceId: 1 }, { unique: true });

const EndpointReliability =
  mongoose.models.EndpointReliability || mongoose.model("EndpointReliability", endpointReliabilitySchema);

export default EndpointReliability;

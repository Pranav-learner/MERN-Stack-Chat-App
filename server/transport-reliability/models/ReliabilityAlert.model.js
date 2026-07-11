/**
 * @module transport-reliability/models/ReliabilityAlert
 *
 * Mongoose schema for a raised monitor alert (Layer 8, Sprint 3). NEW collection; additive. Metadata
 * only — ids, counts, reasons; never payload or keys.
 */

import mongoose from "mongoose";

const reliabilityAlertSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, index: true },
    severity: { type: String, enum: ["info", "warning", "critical"], default: "warning" },
    at: { type: String, index: true },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

const ReliabilityAlert = mongoose.models.TransportReliabilityAlert || mongoose.model("TransportReliabilityAlert", reliabilityAlertSchema);
export default ReliabilityAlert;

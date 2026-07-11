/**
 * @module synchronization-reliability/models/SyncReliabilityAlert
 *
 * Mongoose schema for a raised monitor alert (Layer 9, Sprint 3). NEW collection; additive. Metadata
 * only — ids, counts, reasons; never content or keys.
 */

import mongoose from "mongoose";

const syncReliabilityAlertSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, index: true },
    severity: { type: String, enum: ["info", "warning", "critical"], default: "warning" },
    at: { type: String, index: true },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

const SyncReliabilityAlert = mongoose.models.SyncReliabilityAlert || mongoose.model("SyncReliabilityAlert", syncReliabilityAlertSchema);
export default SyncReliabilityAlert;

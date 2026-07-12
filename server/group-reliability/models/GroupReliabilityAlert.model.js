/**
 * @module group-reliability/models/GroupReliabilityAlert
 *
 * Mongoose schema for a raised monitor alert (Layer 10, Sprint 3). NEW collection
 * (`groupreliabilityalerts`); additive. Stores alert type + severity + numeric details — never content
 * or keys.
 */

import mongoose from "mongoose";

const groupReliabilityAlertSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, index: true },
    severity: { type: String, default: "warning", index: true },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: String, index: true },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

groupReliabilityAlertSchema.index({ type: 1, at: -1 });

const GroupReliabilityAlert = mongoose.models.GroupReliabilityAlert || mongoose.model("GroupReliabilityAlert", groupReliabilityAlertSchema);
export default GroupReliabilityAlert;

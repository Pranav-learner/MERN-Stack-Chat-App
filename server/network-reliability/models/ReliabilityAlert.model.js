/**
 * @module network-reliability/models/ReliabilityAlert
 *
 * Mongoose schema for a persisted reliability alert (Layer 7, Sprint 3). NEW collection; additive.
 *
 * @security PUBLIC alert metadata only — type, severity, subject id, counts. No key material.
 */

import mongoose from "mongoose";

const reliabilityAlertSchema = new mongoose.Schema(
  {
    alertId: { type: String, required: true, unique: true, index: true },
    alertType: { type: String, required: true, index: true },
    severity: { type: String, enum: ["info", "warning", "critical"], default: "warning", index: true },
    message: { type: String },
    subject: { type: String, default: null, index: true },
    count: { type: Number, default: 1 },
    at: { type: Number },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

reliabilityAlertSchema.index({ alertType: 1, createdAt: -1 });

const ReliabilityAlert = mongoose.models.ReliabilityAlert || mongoose.model("ReliabilityAlert", reliabilityAlertSchema);

export default ReliabilityAlert;

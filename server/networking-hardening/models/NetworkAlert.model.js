/**
 * @module networking-hardening/models/NetworkAlert
 *
 * Mongoose schema for a persisted networking alert (Layer 6, Sprint 6). NEW collection; additive.
 * The monitor raises alerts in-process; persisting them lets an operator review history + drives
 * external alerting.
 *
 * @security PUBLIC alert metadata only — type, severity, subject id, counts, reasons. No key
 * material.
 */

import mongoose from "mongoose";

const networkAlertSchema = new mongoose.Schema(
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

networkAlertSchema.index({ alertType: 1, createdAt: -1 });

const NetworkAlert = mongoose.models.NetworkAlert || mongoose.model("NetworkAlert", networkAlertSchema);

export default NetworkAlert;

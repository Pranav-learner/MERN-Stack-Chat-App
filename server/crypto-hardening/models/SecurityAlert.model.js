/**
 * @module crypto-hardening/models/SecurityAlert
 *
 * Mongoose schema for a security ALERT record (Layer 5, Sprint 6). NEW collection; additive.
 *
 * @security Stores alert METADATA ONLY — type, severity, session id, message, and non-secret
 * details. There is no field for key material. Alerts are observability, not crypto.
 */

import mongoose from "mongoose";

const securityAlertSchema = new mongoose.Schema(
  {
    alertId: { type: String, required: true, unique: true, index: true },
    type: { type: String, required: true, index: true },
    severity: { type: String, enum: ["info", "warning", "critical"], required: true, index: true },
    sessionId: { type: String, index: true },
    message: { type: String },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: String },
  },
  { timestamps: true },
);

const SecurityAlert = mongoose.models.SecurityAlert || mongoose.model("SecurityAlert", securityAlertSchema);

export default SecurityAlert;

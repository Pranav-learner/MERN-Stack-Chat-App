/**
 * @module evolution-policy/models/RekeyPolicyState
 *
 * Mongoose schema for an automatic-rekey policy-state record (Layer 5, Sprint 3). NEW
 * collection; additive — it modifies no existing schema.
 *
 * @security This collection stores rekey METADATA ONLY — policy descriptors, the current
 * generation number, execution + rekey history, and audit. There is deliberately **NO
 * field** for a key, chain secret, or shared secret; the cryptography lives entirely in the
 * Sprint 2 forward-secrecy engine (device-local). The server tracks that rekeys happened.
 */

import mongoose from "mongoose";

const policySchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    type: { type: String, required: true },
    params: { type: mongoose.Schema.Types.Mixed, default: {} },
    description: { type: String },
    enabled: { type: Boolean, default: true },
  },
  { _id: false },
);

const executionSchema = new mongoose.Schema(
  {
    executionId: { type: String, required: true },
    sessionId: { type: String },
    state: { type: String, enum: ["pending", "executing", "completed", "failed", "cancelled"], required: true },
    trigger: { type: String },
    policyId: { type: String },
    reason: { type: String },
    expectedGeneration: { type: Number, default: null },
    resultGeneration: { type: Number, default: null },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number },
    error: { type: String, default: null },
    createdAt: { type: String },
    startedAt: { type: String },
    completedAt: { type: String },
    failedAt: { type: String },
  },
  { _id: false },
);

const rekeyHistorySchema = new mongoose.Schema(
  { generation: Number, trigger: String, reason: String, at: String },
  { _id: false },
);

const rekeyPolicyStateSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    handshakeId: { type: String, index: true },
    policies: { type: [policySchema], default: [] },
    config: {
      enabled: { type: Boolean, default: true },
      cooldownMs: { type: Number },
      maxAttempts: { type: Number },
    },
    currentGeneration: { type: Number, default: 0, index: true },
    messageCount: { type: Number, default: 0 },
    lastRekeyAt: { type: String, default: null },
    lastEvaluationAt: { type: String, default: null },
    pending: { type: mongoose.Schema.Types.Mixed, default: null },
    executions: { type: [executionSchema], default: [] },
    rekeyHistory: { type: [rekeyHistorySchema], default: [] },
    audit: { type: [mongoose.Schema.Types.Mixed], default: [] },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    security: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

const RekeyPolicyState =
  mongoose.models.RekeyPolicyState || mongoose.model("RekeyPolicyState", rekeyPolicyStateSchema);

export default RekeyPolicyState;

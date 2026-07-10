/**
 * @module session-evolution/models/EvolutionState
 *
 * Mongoose schema for an evolution record (Layer 5, Sprint 1). NEW collection;
 * additive — it does NOT modify the Secure Session schema or any existing collection.
 *
 * @security This collection stores evolution METADATA ONLY — generation NUMBERS,
 * key-version POINTERS (integers), policy descriptors, lifecycle state, and audit
 * counters. There is deliberately **NO field** for a raw key, shared secret, or ratchet
 * secret. The framework performs no cryptography; the server cannot rotate or derive
 * anything.
 */

import mongoose from "mongoose";

const keyVersionSchema = new mongoose.Schema(
  {
    current: { type: Number, required: true },
    previous: { type: Number, default: null },
    next: { type: Number, default: null },
  },
  { _id: false },
);

const versionEntrySchema = new mongoose.Schema(
  {
    generation: { type: Number, required: true },
    keyVersion: { type: Number, required: true },
    previousGeneration: { type: Number },
    previousKeyVersion: { type: Number, default: null },
    trigger: { type: String },
    reason: { type: String },
    at: { type: String },
  },
  { _id: false },
);

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

const evolutionStateSchema = new mongoose.Schema(
  {
    evolutionId: { type: String, required: true, unique: true, index: true },
    sessionId: { type: String, required: true, unique: true, index: true },
    handshakeId: { type: String, index: true },
    state: {
      type: String,
      enum: ["initialized", "stable", "scheduled", "pending", "evolving", "evolved", "cancelled", "failed", "retired"],
      required: true,
      index: true,
    },
    generation: { type: Number, default: 0, index: true },
    keyVersion: { type: keyVersionSchema, required: true },
    versionHistory: { type: [versionEntrySchema], default: [] },
    policies: { type: [policySchema], default: [] },
    pending: { type: mongoose.Schema.Types.Mixed, default: null },
    lastEvolutionAt: { type: String, default: null },
    evolutionMetadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    policyMetadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    securityMetadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    audit: { type: [mongoose.Schema.Types.Mixed], default: [] },
    // FUTURE placeholders — inert until later Layer 5 sprints populate them.
    ratchetMetadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    chainMetadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    messageMetadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    history: { type: [mongoose.Schema.Types.Mixed], default: [] },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

const EvolutionState =
  mongoose.models.EvolutionState || mongoose.model("EvolutionState", evolutionStateSchema);

export default EvolutionState;

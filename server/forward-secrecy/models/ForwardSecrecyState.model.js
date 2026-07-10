/**
 * @module forward-secrecy/models/ForwardSecrecyState
 *
 * Mongoose schema for a Forward Secrecy metadata record (Layer 5, Sprint 2). NEW
 * collection; additive — it modifies no existing schema.
 *
 * @security This collection stores forward-secrecy METADATA ONLY — the current
 * generation, per-generation key ids / fingerprints / statuses / timestamps, destruction
 * records, and audit. There is deliberately **NO field** for a chain secret, derived key,
 * or shared secret; those never leave the device. The server tracks that generations
 * evolved and were destroyed — it cannot derive or decrypt anything.
 */

import mongoose from "mongoose";

const generationSchema = new mongoose.Schema(
  {
    generation: { type: Number, required: true },
    keyId: { type: String },
    fingerprint: { type: String },
    algorithm: { type: String },
    status: {
      type: String,
      enum: ["pending", "active", "superseded", "expired", "destroyed"],
      required: true,
    },
    createdAt: { type: String },
    activatedAt: { type: String },
    supersededAt: { type: String },
    destroyedAt: { type: String },
    trigger: { type: String },
    reason: { type: String },
  },
  { _id: false },
);

const destructionSchema = new mongoose.Schema(
  {
    scope: { type: String, required: true },
    generation: { type: Number },
    keyId: { type: String },
    fingerprint: { type: String },
    reason: { type: String },
    at: { type: String },
  },
  { _id: false },
);

const forwardSecrecySchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    handshakeId: { type: String, index: true },
    started: { type: Boolean, default: false },
    currentGeneration: { type: Number, default: 0, index: true },
    generations: { type: [generationSchema], default: [] },
    destructions: { type: [destructionSchema], default: [] },
    audit: { type: [mongoose.Schema.Types.Mixed], default: [] },
    security: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

const ForwardSecrecyState =
  mongoose.models.ForwardSecrecyState || mongoose.model("ForwardSecrecyState", forwardSecrecySchema);

export default ForwardSecrecyState;

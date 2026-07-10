/**
 * @module key-hierarchy/models/KeyHierarchyState
 *
 * Mongoose schema for a key-hierarchy metadata record (Layer 5, Sprint 4). NEW collection;
 * additive — modifies no existing schema.
 *
 * @security This collection stores hierarchy METADATA ONLY — root-key + chain ids /
 * fingerprints / generations / indexes / statuses + history + audit. There is deliberately
 * **NO field** for a root key, chain key, or shared secret; those never leave the device.
 * The server tracks the hierarchy's shape; it cannot derive or decrypt anything.
 */

import mongoose from "mongoose";

const rootKeySchema = new mongoose.Schema(
  {
    rootKeyId: { type: String, required: true },
    fingerprint: { type: String },
    generation: { type: Number, default: 0 },
    version: { type: Number, default: 1 },
    status: { type: String, enum: ["active", "superseded", "destroyed"], default: "active" },
    createdAt: { type: String },
    supersededAt: { type: String },
    destroyedAt: { type: String },
  },
  { _id: false },
);

const chainHistorySchema = new mongoose.Schema(
  { index: Number, fingerprint: String, at: String, reason: String },
  { _id: false },
);

const chainSchema = new mongoose.Schema(
  {
    chainId: { type: String, required: true },
    direction: { type: String, enum: ["i2r", "r2i"], required: true },
    role: { type: String, enum: ["sending", "receiving"], required: true },
    generation: { type: Number, default: 0 },
    index: { type: Number, default: 0 },
    version: { type: Number, default: 1 },
    chainKeyId: { type: String },
    fingerprint: { type: String },
    status: { type: String, enum: ["active", "archived", "destroyed"], default: "active" },
    createdAt: { type: String },
    archivedAt: { type: String },
    history: { type: [chainHistorySchema], default: [] },
  },
  { _id: false },
);

const keyHierarchySchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    handshakeId: { type: String, index: true },
    role: { type: String, enum: ["initiator", "responder"] },
    generation: { type: Number, default: 0, index: true },
    rootKey: { type: rootKeySchema, required: true },
    sendingChain: { type: chainSchema, required: true },
    receivingChain: { type: chainSchema, required: true },
    archivedChains: { type: [chainSchema], default: [] },
    rootHistory: { type: [rootKeySchema], default: [] },
    audit: { type: [mongoose.Schema.Types.Mixed], default: [] },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    security: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

const KeyHierarchyState =
  mongoose.models.KeyHierarchyState || mongoose.model("KeyHierarchyState", keyHierarchySchema);

export default KeyHierarchyState;

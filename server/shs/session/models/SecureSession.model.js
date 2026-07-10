/**
 * @module shs/session/models/SecureSession
 *
 * Mongoose schema for a Secure Session (Layer 4, Sprint 3). NEW collection; additive.
 *
 * @security This collection stores session METADATA + key METADATA ONLY (algorithm,
 * length, keyId, fingerprint). There is deliberately **NO field** for a raw
 * encryption key, MAC key, or shared secret — those never leave the device. The
 * server tracks session lifecycle/status; it cannot decrypt anything.
 */

import mongoose from "mongoose";

const keyMetaSchema = new mongoose.Schema(
  {
    algorithm: { type: String, required: true },
    length: { type: Number, required: true },
    keyId: { type: String },
    fingerprint: { type: String },
  },
  { _id: false },
);

const rekeyEntrySchema = new mongoose.Schema(
  { generation: Number, reason: String, strategy: String, at: String },
  { _id: false },
);

const secureSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    handshakeId: { type: String, required: true, index: true },
    participants: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], required: true, index: true },
    deviceIds: {
      initiator: { type: String },
      responder: { type: String },
    },
    protocolVersion: { type: String, required: true },
    /** Encryption key METADATA — never the key bytes. */
    encryptionKey: { type: keyMetaSchema, required: true },
    /** Authentication (MAC) key METADATA — never the key bytes. */
    authenticationKey: { type: keyMetaSchema, required: true },
    status: {
      type: String,
      enum: ["created", "active", "idle", "paused", "resumed", "expired", "closed", "destroyed", "invalid", "failed"],
      required: true,
      index: true,
    },
    generation: { type: Number, default: 0 },
    rekeyHistory: { type: [rekeyEntrySchema], default: [] },
    lastActivityAt: { type: String },
    expiresAt: { type: String },
    maxLifetimeMs: { type: Number },
    idleTimeoutMs: { type: Number },
    security: {
      kdf: { type: String },
      contextSeparated: { type: Boolean },
      purposeSeparated: { type: Boolean },
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    extensions: { type: mongoose.Schema.Types.Mixed, default: {} },
    history: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { timestamps: true },
);

// Fast lookup of the active session for a handshake.
secureSessionSchema.index({ handshakeId: 1, status: 1 });

const SecureSession = mongoose.models.SecureSession || mongoose.model("SecureSession", secureSessionSchema);

export default SecureSession;

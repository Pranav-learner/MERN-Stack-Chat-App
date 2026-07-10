/**
 * @module message-keys/models/MessageKeyState
 *
 * Mongoose schema for a message-key metadata record (Layer 5, Sprint 5). NEW collection;
 * additive — modifies no existing schema.
 *
 * @security This collection stores message METADATA ONLY — per-session counters, generation,
 * a capped message log (numbers / key ids / fingerprints / delivery status), and audit. There
 * is deliberately **NO field** for a message key, chain key, or shared secret. Message keys
 * are ephemeral and device-local; the server tracks only that messages were exchanged.
 */

import mongoose from "mongoose";

const messageMetaSchema = new mongoose.Schema(
  {
    messageId: { type: String },
    direction: { type: String, enum: ["sending", "receiving"] },
    generation: { type: Number },
    messageNumber: { type: Number },
    keyId: { type: String },
    fingerprint: { type: String },
    state: { type: String },
    delivery: { type: String, enum: ["encrypted", "decrypted", "failed"] },
    at: { type: String },
  },
  { _id: false },
);

const messageKeyStateSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    handshakeId: { type: String, index: true },
    generation: { type: Number, default: 0, index: true },
    sending: {
      count: { type: Number, default: 0 },
      lastNumber: { type: Number, default: -1 },
    },
    receiving: {
      count: { type: Number, default: 0 },
      lastNumber: { type: Number, default: -1 },
      highestNumber: { type: Number, default: -1 },
    },
    messages: { type: [messageMetaSchema], default: [] },
    audit: { type: [mongoose.Schema.Types.Mixed], default: [] },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    security: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

const MessageKeyState =
  mongoose.models.MessageKeyState || mongoose.model("MessageKeyState", messageKeyStateSchema);

export default MessageKeyState;

/**
 * @module shs/key-agreement/models/KeyExchange
 *
 * Mongoose schema for the PUBLIC key-exchange coordination record (Layer 4, Sprint
 * 2). NEW collection; additive.
 *
 * @security This collection stores PUBLIC coordination state ONLY — negotiated
 * algorithm/version, the two parties' ephemeral PUBLIC keys, and one-way secret
 * COMMITMENTS. There is deliberately **NO field** for a private key or the shared
 * secret. The server never sees, derives, or stores the shared secret.
 */

import mongoose from "mongoose";

const ephemeralBundleSchema = new mongoose.Schema(
  {
    algorithm: { type: String, required: true },
    /** base64 raw 32-byte X25519 public key — PUBLIC. */
    publicKey: { type: String, required: true },
    keyId: { type: String, required: true },
    version: { type: Number, default: 1 },
    /** Optional Ed25519 identity signature over the ephemeral key (authenticated KE). */
    signature: { type: String },
    identityPublicKey: { type: String },
    createdAt: { type: String },
  },
  { _id: false },
);

const keyExchangeSchema = new mongoose.Schema(
  {
    handshakeId: { type: String, required: true, unique: true, index: true },
    initiator: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    responder: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    algorithm: { type: String, required: true },
    cryptoVersion: { type: String, required: true },
    initiatorKey: { type: ephemeralBundleSchema, default: undefined },
    responderKey: { type: ephemeralBundleSchema, default: undefined },
    /** One-way SHA-256 commitments to each party's derived secret. NOT the secret. */
    initiatorCommitment: { type: String },
    responderCommitment: { type: String },
    state: {
      type: String,
      enum: [
        "negotiated",
        "awaiting_initiator_key",
        "awaiting_responder_key",
        "keys_exchanged",
        "established",
        "failed",
      ],
      required: true,
      index: true,
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    expiresAt: { type: String },
  },
  { timestamps: true },
);

const KeyExchange = mongoose.models.KeyExchange || mongoose.model("KeyExchange", keyExchangeSchema);

export default KeyExchange;

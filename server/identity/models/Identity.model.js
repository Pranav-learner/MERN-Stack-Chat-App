/**
 * @module identity/models/Identity
 *
 * Mongoose schema for a user's long-term cryptographic identity. Stores ONLY
 * public material — there is no field for a private key, by design. One identity
 * per user (unique index on `user`).
 *
 * This is a NEW collection; it does not modify the existing `User`, `Message`, or
 * `Group` schemas.
 */

import mongoose from "mongoose";

const identitySchema = new mongoose.Schema(
  {
    /** Stable identity id (server-generated, e.g. a UUID). */
    identityId: { type: String, required: true, unique: true, index: true },
    /** Owning user (one identity per user). */
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    /** Base64 raw Ed25519 public key. PUBLIC — never a private key. */
    publicKey: { type: String, required: true },
    /** Key algorithm identifier. */
    algorithm: { type: String, required: true, default: "ed25519" },
    /** Canonical hex SHA-256 fingerprint of the public key. */
    fingerprint: { type: String, required: true, unique: true, index: true },
    /** Rotation/version counter (future key rotation). */
    version: { type: Number, required: true, default: 1 },
    /** Lifecycle status. */
    status: {
      type: String,
      enum: ["active", "revoked"],
      default: "active",
    },
    /** Arbitrary caller-defined public metadata (never secret). */
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

const Identity = mongoose.models.Identity || mongoose.model("Identity", identitySchema);

export default Identity;

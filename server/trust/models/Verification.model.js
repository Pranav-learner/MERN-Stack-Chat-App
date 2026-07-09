/**
 * @module trust/models/Verification
 *
 * Mongoose schema for a user→user verification relationship. NEW collection;
 * stores ONLY public material (public keys, fingerprints, safety numbers — all
 * derived from public data). One record per (verifierUser, subjectUser) pair.
 */

import mongoose from "mongoose";

const historyEntrySchema = new mongoose.Schema(
  {
    event: { type: String, required: true },
    at: { type: String, required: true },
    fromFingerprint: { type: String },
    toFingerprint: { type: String },
  },
  { _id: false },
);

const verificationSchema = new mongoose.Schema(
  {
    verificationId: { type: String, required: true, unique: true, index: true },
    verifierUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subjectUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subjectIdentityId: { type: String, required: true },
    /** Subject's identity public key at verification time (base64 raw). PUBLIC. */
    verifiedPublicKey: { type: String, required: true },
    /** Subject's fingerprint at verification time (hex). */
    verifiedFingerprint: { type: String, required: true },
    /** Pairwise safety number at verification time. */
    safetyNumber: { type: String, required: true },
    trustState: {
      type: String,
      enum: ["pending", "verified", "trusted", "changed", "compromised", "revoked", "expired", "blocked"],
      required: true,
      index: true,
    },
    method: { type: String, enum: ["manual", "safety-number", "qr", "fingerprint"], default: "manual" },
    /** Subject's device fingerprints at verification time (for device-add detection). */
    verifiedDeviceFingerprints: { type: [String], default: [] },
    verifiedAt: { type: String },
    lastCheckedAt: { type: String },
    history: { type: [historyEntrySchema], default: [] },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

// One verification per (verifier, subject) pair.
verificationSchema.index({ verifierUser: 1, subjectUser: 1 }, { unique: true });

const Verification =
  mongoose.models.Verification || mongoose.model("Verification", verificationSchema);

export default Verification;

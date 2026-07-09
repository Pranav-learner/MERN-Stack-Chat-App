/**
 * @module trust/models/IdentityChange
 *
 * Mongoose schema for the identity-change history log. Records whenever a
 * subject's identity key is detected to have changed relative to what a verifier
 * had verified. PUBLIC data only. NEW collection.
 */

import mongoose from "mongoose";

const identityChangeSchema = new mongoose.Schema(
  {
    subjectUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    identityId: { type: String },
    fromFingerprint: { type: String, required: true },
    toFingerprint: { type: String, required: true },
    fromPublicKey: { type: String },
    toPublicKey: { type: String },
    /** Which verifier observed the change. */
    detectedByUser: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    detectedAt: { type: String, required: true },
  },
  { timestamps: true },
);

const IdentityChange =
  mongoose.models.IdentityChange || mongoose.model("IdentityChange", identityChangeSchema);

export default IdentityChange;

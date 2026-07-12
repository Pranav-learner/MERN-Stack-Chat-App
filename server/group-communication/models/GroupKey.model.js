/**
 * @module group-communication/models/GroupKey
 *
 * Mongoose schema for a group-key EPOCH's metadata (Layer 10, Sprint 2). NEW collection (`groupkeys`);
 * additive. Stores version + opaque fingerprint (commitment) + distribution + expiry metadata ONLY — no
 * key bytes / secrets. Group keys are derived + held device-local.
 */

import mongoose from "mongoose";

const groupKeySchema = new mongoose.Schema(
  {
    groupId: { type: String, required: true, index: true },
    keyVersion: { type: Number, required: true },
    keyId: { type: String, index: true },
    fingerprint: { type: String, required: true },
    algorithm: { type: String, default: "HKDF-SHA256" },
    state: { type: String, default: "active", index: true },
    trigger: { type: String },
    createdBy: { type: String },
    expiresAt: { type: String, default: null },
    memberSetHash: { type: String },
    distribution: { type: [mongoose.Schema.Types.Mixed], default: [] },
    supersededBy: { type: Number, default: null },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

groupKeySchema.index({ groupId: 1, keyVersion: 1 }, { unique: true });
groupKeySchema.index({ groupId: 1, state: 1 });

const GroupKey = mongoose.models.GroupKey || mongoose.model("GroupKey", groupKeySchema);
export default GroupKey;

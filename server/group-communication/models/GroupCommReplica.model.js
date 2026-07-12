/**
 * @module group-communication/models/GroupCommReplica
 *
 * Mongoose schema for a per-device group-communication replica (Layer 10, Sprint 2). NEW collection
 * (`groupcommreplicas`); additive. Stores facet versions + key version + delivery cursor + pending
 * updates + an opaque fingerprint — never ciphertext or keys.
 */

import mongoose from "mongoose";

const groupCommReplicaSchema = new mongoose.Schema(
  {
    replicaId: { type: String, index: true },
    groupId: { type: String, required: true, index: true },
    deviceId: { type: String, required: true, index: true },
    memberId: { type: String, index: true },
    facetVersions: { type: mongoose.Schema.Types.Mixed, default: {} },
    keyVersion: { type: Number, default: 0 },
    deliveryCursor: { type: mongoose.Schema.Types.Mixed, default: {} },
    pendingUpdates: { type: [mongoose.Schema.Types.Mixed], default: [] },
    recovery: { type: mongoose.Schema.Types.Mixed, default: {} },
    diagnostics: { type: mongoose.Schema.Types.Mixed, default: {} },
    fingerprint: { type: String },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

groupCommReplicaSchema.index({ groupId: 1, deviceId: 1 }, { unique: true });

const GroupCommReplica = mongoose.models.GroupCommReplica || mongoose.model("GroupCommReplica", groupCommReplicaSchema);
export default GroupCommReplica;

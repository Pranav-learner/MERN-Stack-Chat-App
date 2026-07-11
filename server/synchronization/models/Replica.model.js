/**
 * @module synchronization/models/Replica
 *
 * Mongoose schema for a device's synchronization REPLICA (Layer 9, Sprint 1). NEW collection;
 * additive. Stores per-category VERSION MAPS + sync metadata only — no plaintext, ciphertext, or keys.
 */

import mongoose from "mongoose";

const replicaSchema = new mongoose.Schema(
  {
    replicaId: { type: String, required: true, unique: true, index: true },
    deviceId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    // { [category]: { version: Number, entities: { entityId: version } } } — versions only.
    categoryVersions: { type: mongoose.Schema.Types.Mixed, default: {} },
    syncVersion: { type: Number, default: 1 },
    lastSuccessfulSync: { type: String, default: null },
    pendingChanges: { type: Number, default: 0 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    version: { type: Number, default: 1 },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

replicaSchema.index({ userId: 1, deviceId: 1 });

const Replica = mongoose.models.SyncReplica || mongoose.model("SyncReplica", replicaSchema);
export default Replica;

/**
 * @module replication/models/ReplicaSnapshot
 *
 * Mongoose schema for a device's replica SNAPSHOT (Layer 9, Sprint 2). NEW collection; additive.
 * Stores per-category version records + non-secret merge metadata only — no plaintext/ciphertext/keys.
 */

import mongoose from "mongoose";

const replicaSnapshotSchema = new mongoose.Schema(
  {
    replicaId: { type: String, required: true, unique: true, index: true },
    deviceId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    // { [category]: { entityId: { version, writerReplicaId, updatedAt, contentHash, deleted?, meta? } } }
    categories: { type: mongoose.Schema.Types.Mixed, default: {} },
    replicaVersion: { type: Number, default: 1 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    version: { type: Number, default: 1 },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

replicaSnapshotSchema.index({ userId: 1, deviceId: 1 });

const ReplicaSnapshot = mongoose.models.ReplicaSnapshot || mongoose.model("ReplicaSnapshot", replicaSnapshotSchema);
export default ReplicaSnapshot;

/**
 * @module group/models/GroupReplicaState
 *
 * Mongoose schema for a group's replica snapshot (Layer 10, Sprint 1) — the per-group projection a
 * device reconciles. NEW collection (`groupreplicastates`); additive. Stores membership/metadata
 * snapshots + version vector + an opaque fingerprint only — no keys / message content.
 */

import mongoose from "mongoose";

const groupReplicaStateSchema = new mongoose.Schema(
  {
    groupId: { type: String, required: true, unique: true, index: true },
    replicaId: { type: String, index: true },
    replicaVersion: { type: Number, default: 1 },
    membershipSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    metadataSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    versions: { type: mongoose.Schema.Types.Mixed, default: {} },
    pendingUpdates: { type: [mongoose.Schema.Types.Mixed], default: [] },
    syncMetadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    diagnostics: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

const GroupReplicaState = mongoose.models.GroupReplicaState || mongoose.model("GroupReplicaState", groupReplicaStateSchema);
export default GroupReplicaState;

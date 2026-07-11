/**
 * @module replication/models/ReplicationHistory
 *
 * Mongoose schema for the replication audit trail (Layer 9, Sprint 2) — conflicts, merges, version
 * history, delta replications, and replica-lifecycle entries in ONE additive collection keyed by
 * `kind`. Metadata only (ids, versions, policies, counts); never content.
 */

import mongoose from "mongoose";

const replicationHistorySchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["replica", "conflict", "merge", "version", "delta", "audit"], required: true, index: true },
    replicaId: { type: String, index: true },
    sourceReplicaId: { type: String, index: true },
    targetReplicaId: { type: String, index: true },
    category: { type: String },
    entityId: { type: String },
    policy: { type: String },
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: String, index: true },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

replicationHistorySchema.index({ kind: 1, replicaId: 1, at: -1 });

const ReplicationHistory = mongoose.models.ReplicationHistory || mongoose.model("ReplicationHistory", replicationHistorySchema);
export default ReplicationHistory;

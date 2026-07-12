/**
 * @module group/models/GroupHistory
 *
 * Mongoose schema for the group audit trail (Layer 10, Sprint 1) — version, metadata, role, permission,
 * membership, and free-form audit entries in ONE additive collection (`grouphistories`) keyed by
 * `kind`. Metadata only (ids, versions, roles, states, actors, counts) — never keys / message content.
 */

import mongoose from "mongoose";

const groupHistorySchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["version", "metadata", "role", "permission", "membership", "audit"], required: true, index: true },
    groupId: { type: String, index: true },
    memberId: { type: String, index: true },
    actorId: { type: String },
    action: { type: String },
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: String, index: true },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

groupHistorySchema.index({ kind: 1, groupId: 1, at: -1 });

const GroupHistory = mongoose.models.GroupHistory || mongoose.model("GroupHistory", groupHistorySchema);
export default GroupHistory;

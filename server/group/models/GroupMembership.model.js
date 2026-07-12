/**
 * @module group/models/GroupMembership
 *
 * Mongoose schema for a single membership (Layer 10, Sprint 1) — one record per (group, member) with a
 * role, a lifecycle state, and its own version. NEW collection (`groupmemberships`); additive. Metadata
 * only (ids, role, state, timestamps) — no keys / message content.
 */

import mongoose from "mongoose";

const groupMembershipSchema = new mongoose.Schema(
  {
    membershipId: { type: String, required: true, unique: true, index: true },
    groupId: { type: String, required: true, index: true },
    memberId: { type: String, required: true, index: true },
    role: { type: String, default: "member", index: true },
    state: { type: String, default: "active", index: true },
    invitedBy: { type: String, default: null },
    invitedAt: { type: String },
    joinedAt: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    version: { type: Number, default: 1 },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

// One membership per (group, member); fast member-list + my-groups lookups.
groupMembershipSchema.index({ groupId: 1, memberId: 1 }, { unique: true });
groupMembershipSchema.index({ groupId: 1, state: 1 });
groupMembershipSchema.index({ memberId: 1, state: 1 });

const GroupMembership = mongoose.models.GroupMembership || mongoose.model("GroupMembership", groupMembershipSchema);
export default GroupMembership;

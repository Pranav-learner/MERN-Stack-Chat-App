/**
 * @module group/models/ManagedGroup
 *
 * Mongoose schema for the Group Foundation entity (Layer 10, Sprint 1). NEW collection (`managedgroups`);
 * additive — it does NOT touch the existing Layer 1 `Group` chat collection. Stores group identity +
 * versioned metadata + version vector + per-role permission overrides only — no keys / message content.
 */

import mongoose from "mongoose";

const managedGroupSchema = new mongoose.Schema(
  {
    groupId: { type: String, required: true, unique: true, index: true },
    ownerId: { type: String, required: true, index: true },
    state: { type: String, default: "active", index: true },
    // { name, description, avatar, tags, visibility, announcement, custom, version, updatedAt }
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    visibility: { type: String, default: "private", index: true },
    // { group, membership, metadata, role, permission, replica }
    versions: { type: mongoose.Schema.Types.Mixed, default: {} },
    // { [role]: { grant: [...], revoke: [...] } }
    permissionOverrides: { type: mongoose.Schema.Types.Mixed, default: {} },
    audit: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

managedGroupSchema.index({ ownerId: 1, state: 1 });

const ManagedGroup = mongoose.models.ManagedGroup || mongoose.model("ManagedGroup", managedGroupSchema);
export default ManagedGroup;

/**
 * @module group/repository/mongo
 *
 * MongoDB (Mongoose) group repositories. Mirror the in-memory contracts exactly, so the manager is
 * storage-independent — swap this for the in-memory bundle and nothing else changes. Store group
 * identity + membership + replica snapshots + history metadata only (no keys / message content). Reads
 * use `.lean()`. History (version, metadata, role, permission, membership, audit) shares one
 * `GroupHistory` collection keyed by `kind`.
 */

import ManagedGroup from "../models/ManagedGroup.model.js";
import GroupMembership from "../models/GroupMembership.model.js";
import GroupReplicaState from "../models/GroupReplicaState.model.js";
import GroupHistory from "../models/GroupHistory.model.js";
import { GroupNotFoundError, MembershipNotFoundError } from "../errors.js";

export function createMongoGroupRepository(models = {}) {
  const GroupModel = models.ManagedGroupModel ?? ManagedGroup;
  const MembershipModel = models.GroupMembershipModel ?? GroupMembership;
  const ReplicaModel = models.GroupReplicaStateModel ?? GroupReplicaState;
  const HistoryModel = models.GroupHistoryModel ?? GroupHistory;

  const groups = {
    async create(group) {
      const doc = await GroupModel.create(group);
      return stripMongo(doc.toObject());
    },
    async findById(groupId) {
      return stripMongo(await GroupModel.findOne({ groupId: String(groupId) }).lean());
    },
    async update(groupId, patch) {
      const updated = await GroupModel.findOneAndUpdate({ groupId: String(groupId) }, { $set: patch }, { new: true }).lean();
      if (!updated) throw new GroupNotFoundError("Group not found", { details: { groupId } });
      return stripMongo(updated);
    },
    async delete(groupId) {
      const res = await GroupModel.deleteOne({ groupId: String(groupId) });
      return res.deletedCount > 0;
    },
    async listByOwner(ownerId) {
      return (await GroupModel.find({ ownerId: String(ownerId) }).lean()).map(stripMongo);
    },
    async exists(groupId) {
      return (await GroupModel.countDocuments({ groupId: String(groupId) })) > 0;
    },
  };

  const memberships = {
    async upsert(membership) {
      const doc = await MembershipModel.findOneAndUpdate({ membershipId: String(membership.membershipId) }, { $set: membership }, { new: true, upsert: true }).lean();
      return stripMongo(doc);
    },
    async findById(membershipId) {
      return stripMongo(await MembershipModel.findOne({ membershipId: String(membershipId) }).lean());
    },
    async findByGroupAndMember(groupId, memberId) {
      return stripMongo(await MembershipModel.findOne({ groupId: String(groupId), memberId: String(memberId) }).lean());
    },
    async listByGroup(groupId, { states } = {}) {
      const q = { groupId: String(groupId) };
      if (states) q.state = { $in: states };
      return (await MembershipModel.find(q).sort({ createdAt: 1 }).lean()).map(stripMongo);
    },
    async listByMember(memberId, { states } = {}) {
      const q = { memberId: String(memberId) };
      if (states) q.state = { $in: states };
      return (await MembershipModel.find(q).lean()).map(stripMongo);
    },
    async update(membershipId, patch) {
      const updated = await MembershipModel.findOneAndUpdate({ membershipId: String(membershipId) }, { $set: patch }, { new: true }).lean();
      if (!updated) throw new MembershipNotFoundError("Membership not found", { details: { membershipId } });
      return stripMongo(updated);
    },
    async delete(membershipId) {
      const res = await MembershipModel.deleteOne({ membershipId: String(membershipId) });
      return res.deletedCount > 0;
    },
    async countByGroup(groupId, { states } = {}) {
      const q = { groupId: String(groupId) };
      if (states) q.state = { $in: states };
      return MembershipModel.countDocuments(q);
    },
  };

  const replicaState = {
    async upsert(snapshot) {
      const doc = await ReplicaModel.findOneAndUpdate({ groupId: String(snapshot.groupId) }, { $set: snapshot }, { new: true, upsert: true }).lean();
      return stripMongo(doc);
    },
    async findByGroup(groupId) {
      return stripMongo(await ReplicaModel.findOne({ groupId: String(groupId) }).lean());
    },
    async update(groupId, patch) {
      const doc = await ReplicaModel.findOneAndUpdate({ groupId: String(groupId) }, { $set: patch }, { new: true, upsert: true }).lean();
      return stripMongo(doc);
    },
  };

  const makeHistory = (kind) => ({
    async record(entry) {
      const doc = await HistoryModel.create({ kind, groupId: entry.groupId, memberId: entry.memberId, actorId: entry.actorId, action: entry.action, detail: entry, at: entry.at ?? new Date().toISOString() });
      return stripMongo(doc.toObject());
    },
    async listByGroup(groupId, options = {}) {
      const q = HistoryModel.find({ kind, groupId: String(groupId) }).sort({ at: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map((d) => stripMongo(d).detail ?? stripMongo(d));
    },
    async list(options = {}) {
      const q = HistoryModel.find({ kind }).sort({ at: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map((d) => stripMongo(d).detail ?? stripMongo(d));
    },
  });

  return {
    groups,
    memberships,
    replicaState,
    versionHistory: makeHistory("version"),
    metadataHistory: makeHistory("metadata"),
    roleHistory: makeHistory("role"),
    permissionHistory: makeHistory("permission"),
    membershipHistory: makeHistory("membership"),
    audit: makeHistory("audit"),
  };
}

function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

/**
 * @module replication/repository/mongo
 *
 * MongoDB (Mongoose) replication repositories. Mirror the in-memory contracts. Store replica snapshots
 * + history metadata only — no plaintext / key field. Reads use `.lean()`. History (conflicts, merges,
 * versions, deltas, replica lifecycle) shares one `ReplicationHistory` collection keyed by `kind`.
 */

import ReplicaSnapshot from "../models/ReplicaSnapshot.model.js";
import ReplicationHistory from "../models/ReplicationHistory.model.js";
import { ReplicaNotFoundError } from "../errors.js";

export function createMongoReplicationRepository(models = {}) {
  const ReplicaModel = models.ReplicaSnapshotModel ?? ReplicaSnapshot;
  const HistoryModel = models.ReplicationHistoryModel ?? ReplicationHistory;

  const replicas = {
    async upsert(replica) {
      const doc = await ReplicaModel.findOneAndUpdate({ replicaId: String(replica.replicaId) }, { $set: replica }, { new: true, upsert: true }).lean();
      return stripMongo(doc);
    },
    async findById(replicaId) {
      return stripMongo(await ReplicaModel.findOne({ replicaId: String(replicaId) }).lean());
    },
    async findByDevice(deviceId) {
      return stripMongo(await ReplicaModel.findOne({ deviceId: String(deviceId) }).sort({ updatedAt: -1 }).lean());
    },
    async listByUser(userId) {
      return (await ReplicaModel.find({ userId: String(userId) }).lean()).map(stripMongo);
    },
    async update(replicaId, patch) {
      const updated = await ReplicaModel.findOneAndUpdate({ replicaId: String(replicaId) }, patch, { new: true }).lean();
      if (!updated) throw new ReplicaNotFoundError("Replica not found", { details: { replicaId } });
      return stripMongo(updated);
    },
    async delete(replicaId) {
      const res = await ReplicaModel.deleteOne({ replicaId: String(replicaId) });
      return res.deletedCount > 0;
    },
    async countByUser(userId) {
      return ReplicaModel.countDocuments({ userId: String(userId) });
    },
  };

  const makeHistory = (kind) => ({
    async record(entry) {
      const doc = await HistoryModel.create({ kind, replicaId: entry.replicaId, sourceReplicaId: entry.sourceReplicaId, targetReplicaId: entry.targetReplicaId, category: entry.category, entityId: entry.entityId, policy: entry.policy, detail: entry, at: entry.at ?? new Date().toISOString() });
      return stripMongo(doc.toObject());
    },
    async listByReplica(replicaId, options = {}) {
      const id = String(replicaId);
      const q = HistoryModel.find({ kind, $or: [{ replicaId: id }, { sourceReplicaId: id }, { targetReplicaId: id }] }).sort({ at: -1 });
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
    replicas,
    conflictHistory: makeHistory("conflict"),
    mergeHistory: makeHistory("merge"),
    versionHistory: makeHistory("version"),
    deltaHistory: makeHistory("delta"),
    replicaHistory: makeHistory("replica"),
    audit: makeHistory("audit"),
  };
}

function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

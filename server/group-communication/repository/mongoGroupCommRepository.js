/**
 * @module group-communication/repository/mongo
 *
 * MongoDB (Mongoose) group-communication repositories. Mirror the in-memory contracts exactly, so the
 * engine is storage-independent. Store key epoch metadata + opaque messages + fan-out plans + replicas +
 * history only (no key bytes / plaintext). Reads use `.lean()`. History + the offline pending queue
 * share one `GroupCommHistory` collection keyed by `kind`.
 */

import GroupKey from "../models/GroupKey.model.js";
import GroupMessage from "../models/GroupMessage.model.js";
import GroupFanoutPlan from "../models/GroupFanoutPlan.model.js";
import GroupCommReplica from "../models/GroupCommReplica.model.js";
import GroupCommHistory from "../models/GroupCommHistory.model.js";
import { GroupKeyState } from "../types/types.js";

export function createMongoGroupCommRepository(models = {}) {
  const KeyModel = models.GroupKeyModel ?? GroupKey;
  const MessageModel = models.GroupMessageModel ?? GroupMessage;
  const PlanModel = models.GroupFanoutPlanModel ?? GroupFanoutPlan;
  const ReplicaModel = models.GroupCommReplicaModel ?? GroupCommReplica;
  const HistoryModel = models.GroupCommHistoryModel ?? GroupCommHistory;

  const keys = {
    async create(record) {
      const doc = await KeyModel.create(record);
      return stripMongo(doc.toObject());
    },
    async findActive(groupId) {
      return stripMongo(await KeyModel.findOne({ groupId: String(groupId), state: GroupKeyState.ACTIVE }).sort({ keyVersion: -1 }).lean());
    },
    async findByVersion(groupId, keyVersion) {
      return stripMongo(await KeyModel.findOne({ groupId: String(groupId), keyVersion: Number(keyVersion) }).lean());
    },
    async listByGroup(groupId) {
      return (await KeyModel.find({ groupId: String(groupId) }).sort({ keyVersion: -1 }).lean()).map(stripMongo);
    },
    async update(groupId, keyVersion, patch) {
      return stripMongo(await KeyModel.findOneAndUpdate({ groupId: String(groupId), keyVersion: Number(keyVersion) }, { $set: patch }, { new: true }).lean());
    },
  };

  const messages = {
    async create(message) {
      const doc = await MessageModel.create(message);
      return stripMongo(doc.toObject());
    },
    async findById(messageId) {
      return stripMongo(await MessageModel.findOne({ messageId: String(messageId) }).lean());
    },
    async listByGroup(groupId, { limit, offset = 0 } = {}) {
      const q = MessageModel.find({ groupId: String(groupId) }).sort({ createdAt: -1 });
      if (offset) q.skip(offset);
      if (limit) q.limit(limit);
      return (await q.lean()).map(stripMongo);
    },
    async listAfter(groupId, cursorAt) {
      const q = { groupId: String(groupId) };
      if (cursorAt) q.createdAt = { $gt: cursorAt };
      return (await MessageModel.find(q).sort({ createdAt: 1 }).lean()).map(stripMongo);
    },
    async count(groupId) {
      return MessageModel.countDocuments({ groupId: String(groupId) });
    },
  };

  const fanoutPlans = {
    async create(plan) {
      const doc = await PlanModel.create(plan);
      return stripMongo(doc.toObject());
    },
    async findById(planId) {
      return stripMongo(await PlanModel.findOne({ planId: String(planId) }).lean());
    },
    async findByMessage(messageId) {
      return stripMongo(await PlanModel.findOne({ messageId: String(messageId) }).sort({ createdAt: -1 }).lean());
    },
    async listByGroup(groupId, { limit } = {}) {
      const q = PlanModel.find({ groupId: String(groupId) }).sort({ createdAt: -1 });
      if (limit) q.limit(limit);
      return (await q.lean()).map(stripMongo);
    },
    async update(planId, patch) {
      return stripMongo(await PlanModel.findOneAndUpdate({ planId: String(planId) }, { $set: patch }, { new: true }).lean());
    },
  };

  const replicas = {
    async upsert(replica) {
      const doc = await ReplicaModel.findOneAndUpdate({ groupId: String(replica.groupId), deviceId: String(replica.deviceId) }, { $set: replica }, { new: true, upsert: true }).lean();
      return stripMongo(doc);
    },
    async findByDevice(groupId, deviceId) {
      return stripMongo(await ReplicaModel.findOne({ groupId: String(groupId), deviceId: String(deviceId) }).lean());
    },
    async listByGroup(groupId) {
      return (await ReplicaModel.find({ groupId: String(groupId) }).lean()).map(stripMongo);
    },
    async update(groupId, deviceId, patch) {
      return stripMongo(await ReplicaModel.findOneAndUpdate({ groupId: String(groupId), deviceId: String(deviceId) }, { $set: patch }, { new: true }).lean());
    },
  };

  const pendingQueue = {
    async enqueue(entry) {
      const doc = await HistoryModel.create({ kind: "pending", groupId: entry.groupId, deviceId: entry.deviceId, memberId: entry.memberId, messageId: entry.messageId, detail: entry, at: entry.at ?? new Date().toISOString() });
      return stripMongo(doc.toObject()).detail;
    },
    async listByDevice(groupId, deviceId) {
      return (await HistoryModel.find({ kind: "pending", groupId: String(groupId), deviceId: String(deviceId) }).lean()).map((d) => stripMongo(d).detail);
    },
    async listByGroup(groupId) {
      return (await HistoryModel.find({ kind: "pending", groupId: String(groupId) }).lean()).map((d) => stripMongo(d).detail);
    },
    async drainDevice(groupId, deviceId) {
      const docs = await HistoryModel.find({ kind: "pending", groupId: String(groupId), deviceId: String(deviceId) }).lean();
      await HistoryModel.deleteMany({ kind: "pending", groupId: String(groupId), deviceId: String(deviceId) });
      return docs.map((d) => stripMongo(d).detail);
    },
    async count(groupId) {
      return HistoryModel.countDocuments({ kind: "pending", groupId: String(groupId) });
    },
  };

  const makeHistory = (kind) => ({
    async record(entry) {
      const doc = await HistoryModel.create({ kind, groupId: entry.groupId, deviceId: entry.deviceId, memberId: entry.memberId, messageId: entry.messageId, keyVersion: entry.keyVersion, action: entry.action, detail: entry, at: entry.at ?? new Date().toISOString() });
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
    keys,
    messages,
    fanoutPlans,
    replicas,
    pendingQueue,
    keyAudit: makeHistory("key"),
    deliveryAudit: makeHistory("delivery"),
    syncHistory: makeHistory("sync"),
    audit: makeHistory("audit"),
  };
}

function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

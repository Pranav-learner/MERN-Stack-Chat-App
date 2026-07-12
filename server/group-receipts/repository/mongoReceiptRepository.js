/**
 * @module group-receipts/repository/mongo
 *
 * MongoDB (Mongoose) receipt repositories. Mirror the in-memory contracts exactly, so the manager is
 * storage-independent. Store aggregates + per-member receipts + analytics + history only (no content/
 * keys). Reads use `.lean()`. Reader / pending scans use the compound `(messageId, memberRead/
 * memberDelivered)` indexes, so a list query hits an index, not a collection scan.
 */

import GroupReceiptAggregate from "../models/GroupReceiptAggregate.model.js";
import GroupMemberReceipt from "../models/GroupMemberReceipt.model.js";
import GroupReceiptHistory from "../models/GroupReceiptHistory.model.js";
import { ReceiptNotFoundError } from "../errors.js";

export function createMongoReceiptRepository(models = {}) {
  const AggregateModel = models.GroupReceiptAggregateModel ?? GroupReceiptAggregate;
  const MemberModel = models.GroupMemberReceiptModel ?? GroupMemberReceipt;
  const HistoryModel = models.GroupReceiptHistoryModel ?? GroupReceiptHistory;

  const aggregates = {
    async create(aggregate) {
      const doc = await AggregateModel.create(aggregate);
      return stripMongo(doc.toObject());
    },
    async findById(messageId) {
      return stripMongo(await AggregateModel.findOne({ messageId: String(messageId) }).lean());
    },
    async update(messageId, patch) {
      const updated = await AggregateModel.findOneAndUpdate({ messageId: String(messageId) }, { $set: patch }, { new: true }).lean();
      if (!updated) throw new ReceiptNotFoundError("Receipt aggregate not found", { details: { messageId } });
      return stripMongo(updated);
    },
    async delete(messageId) {
      const res = await AggregateModel.deleteOne({ messageId: String(messageId) });
      return res.deletedCount > 0;
    },
    async listByGroup(groupId, { limit } = {}) {
      const q = AggregateModel.find({ groupId: String(groupId) }).sort({ sentAt: -1 });
      if (limit) q.limit(limit);
      return (await q.lean()).map(stripMongo);
    },
  };

  const memberReceipts = {
    async upsert(record) {
      const doc = await MemberModel.findOneAndUpdate({ messageId: String(record.messageId), memberId: String(record.memberId) }, { $set: record }, { new: true, upsert: true }).lean();
      return stripMongo(doc);
    },
    async find(messageId, memberId) {
      return stripMongo(await MemberModel.findOne({ messageId: String(messageId), memberId: String(memberId) }).lean());
    },
    async listByMessage(messageId, { filter, limit, offset = 0 } = {}) {
      const q = { messageId: String(messageId) };
      if (filter === "read") q.memberRead = true;
      else if (filter === "delivered") q.memberDelivered = true;
      else if (filter === "pending") q.memberDelivered = false;
      const cursor = MemberModel.find(q).sort({ memberId: 1 });
      if (offset) cursor.skip(offset);
      if (limit) cursor.limit(limit);
      return (await cursor.lean()).map(stripMongo);
    },
    async countByMessage(messageId, filter) {
      const q = { messageId: String(messageId) };
      if (filter === "read") q.memberRead = true;
      else if (filter === "delivered") q.memberDelivered = true;
      else if (filter === "pending") q.memberDelivered = false;
      return MemberModel.countDocuments(q);
    },
  };

  const analytics = {
    async upsert(snapshot) {
      const doc = await HistoryModel.findOneAndUpdate({ kind: "analytics", messageId: String(snapshot.messageId) }, { $set: { kind: "analytics", messageId: String(snapshot.messageId), groupId: snapshot.groupId, detail: snapshot, at: snapshot.updatedAt ?? new Date().toISOString() } }, { new: true, upsert: true }).lean();
      return stripMongo(doc).detail;
    },
    async findById(messageId) {
      const doc = await HistoryModel.findOne({ kind: "analytics", messageId: String(messageId) }).lean();
      return doc ? stripMongo(doc).detail : null;
    },
  };

  const makeHistory = (kind) => ({
    async record(entry) {
      const doc = await HistoryModel.create({ kind, messageId: entry.messageId, groupId: entry.groupId, memberId: entry.memberId, event: entry.event, tick: entry.tick, detail: entry, at: entry.at ?? new Date().toISOString() });
      return stripMongo(doc.toObject());
    },
    async listByMessage(messageId, options = {}) {
      const q = HistoryModel.find({ kind, messageId: String(messageId) }).sort({ at: -1 });
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
    aggregates,
    memberReceipts,
    analytics,
    receiptHistory: makeHistory("receipt"),
    audit: makeHistory("audit"),
  };
}

function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

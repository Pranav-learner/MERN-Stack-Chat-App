/**
 * @module data-plane/repository/mongo
 *
 * MongoDB (Mongoose) data-plane repositories. Mirror the in-memory contracts. Store delivery
 * metadata + the OPAQUE ciphertext only — no plaintext / key field. Reads use `.lean()`. The
 * `nextSequence` uses an atomic `$inc` on a per-conversation-stream counter document.
 */

import DataMessage from "../models/DataMessage.model.js";
import InboundMessage from "../models/InboundMessage.model.js";
import AckRecord from "../models/AckRecord.model.js";
import { MessageNotFoundError } from "../errors.js";
import { ACTIVE_DELIVERY_STATES, DeliveryState } from "../types/types.js";
import mongoose from "mongoose";

const RETRYABLE = [DeliveryState.SENT, DeliveryState.QUEUED, DeliveryState.SENDING];

// A tiny per-(conversation, sender) sequence counter collection (atomic monotonic sequences).
const sequenceSchema = new mongoose.Schema({ streamKey: { type: String, unique: true, index: true }, seq: { type: Number, default: 0 } });
const SequenceCounter = mongoose.models.DataSequenceCounter || mongoose.model("DataSequenceCounter", sequenceSchema);

// A per-conversation ordering-metadata collection.
const orderingSchema = new mongoose.Schema({ conversationId: { type: String, unique: true, index: true }, expected: { type: Number, default: 1 }, buffered: { type: [Number], default: [] } });
const OrderingMetadata = mongoose.models.DataOrderingMetadata || mongoose.model("DataOrderingMetadata", orderingSchema);

/**
 * @param {object} [models]
 * @returns {{ messages: object, inbound: object, ackHistory: object, ordering: object }}
 */
export function createMongoMessageRepository(models = {}) {
  const MessageModel = models.DataMessageModel ?? DataMessage;
  const InboundModel = models.InboundMessageModel ?? InboundMessage;
  const AckModel = models.AckRecordModel ?? AckRecord;
  const SeqModel = models.SequenceCounterModel ?? SequenceCounter;
  const OrderingModel = models.OrderingMetadataModel ?? OrderingMetadata;

  const messages = {
    async create(m) {
      const doc = await MessageModel.create(m);
      return stripMongo(doc.toObject());
    },
    async findById(messageId) {
      return stripMongo(await MessageModel.findOne({ messageId: String(messageId) }).lean());
    },
    async update(messageId, patch) {
      const updated = await MessageModel.findOneAndUpdate({ messageId: String(messageId) }, patch, { new: true }).lean();
      if (!updated) throw new MessageNotFoundError("Message not found", { details: { messageId } });
      return stripMongo(updated);
    },
    async delete(messageId) {
      const res = await MessageModel.deleteOne({ messageId: String(messageId) });
      return res.deletedCount > 0;
    },
    async listPendingByConnection(connectionId) {
      const filter = { state: { $in: ACTIVE_DELIVERY_STATES } };
      if (connectionId != null) filter.connectionId = String(connectionId);
      return (await MessageModel.find(filter).sort({ sequenceNumber: 1 }).lean()).map(stripMongo);
    },
    async listRetryDue(nowIso) {
      const now = nowIso ?? new Date().toISOString();
      return (await MessageModel.find({ state: { $in: RETRYABLE }, nextRetryAt: { $lte: now, $ne: null } }).lean()).map(stripMongo);
    },
    async listExpired(nowIso) {
      const now = nowIso ?? new Date().toISOString();
      return (await MessageModel.find({ state: { $in: ACTIVE_DELIVERY_STATES }, expiresAt: { $lte: now } }).lean()).map(stripMongo);
    },
    async listByConversation(conversationId, options = {}) {
      const q = MessageModel.find({ conversationId: String(conversationId) }).sort({ sequenceNumber: 1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
    async countByState() {
      const rows = await MessageModel.aggregate([{ $group: { _id: "$state", count: { $sum: 1 } } }]);
      const counts = {};
      for (const r of rows) counts[r._id] = r.count;
      return counts;
    },
    async nextSequence(conversationId, senderDeviceId) {
      const doc = await SeqModel.findOneAndUpdate({ streamKey: `${conversationId}|${senderDeviceId}` }, { $inc: { seq: 1 } }, { new: true, upsert: true }).lean();
      return doc.seq;
    },
  };

  const inbound = {
    async record(m) {
      const doc = await InboundModel.findOneAndUpdate({ messageId: String(m.messageId) }, { $set: m }, { new: true, upsert: true }).lean();
      return stripMongo(doc);
    },
    async findById(messageId) {
      return stripMongo(await InboundModel.findOne({ messageId: String(messageId) }).lean());
    },
    async listByConversation(conversationId, options = {}) {
      const q = InboundModel.find({ conversationId: String(conversationId) }).sort({ sequenceNumber: 1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
  };

  const ackHistory = {
    async record(ack) {
      const doc = await AckModel.create(ack);
      return stripMongo(doc.toObject());
    },
    async listByMessage(messageId) {
      return (await AckModel.find({ messageId: String(messageId) }).lean()).map(stripMongo);
    },
    async listByConversation(conversationId, options = {}) {
      const q = AckModel.find({ conversationId: String(conversationId) }).sort({ at: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
  };

  const ordering = {
    async getMetadata(conversationId) {
      return stripMongo(await OrderingModel.findOne({ conversationId: String(conversationId) }).lean());
    },
    async saveMetadata(conversationId, metadata) {
      const doc = await OrderingModel.findOneAndUpdate({ conversationId: String(conversationId) }, { $set: metadata }, { new: true, upsert: true }).lean();
      return stripMongo(doc);
    },
  };

  return { messages, inbound, ackHistory, ordering };
}

function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

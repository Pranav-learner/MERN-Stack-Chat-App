/**
 * @module transport-engine/repository/mongo
 *
 * MongoDB (Mongoose) transport repositories. Mirror the in-memory contracts. Store transfer metadata +
 * the OPAQUE ciphertext fragments only — no plaintext / key field. Reads use `.lean()`.
 */

import Transfer from "../models/Transfer.model.js";
import TransferChunk from "../models/TransferChunk.model.js";
import { TransferNotFoundError, ChunkValidationError } from "../errors.js";
import { ACTIVE_TRANSFER_STATES, ChunkState } from "../types/types.js";
import mongoose from "mongoose";

const RETRYABLE = [ChunkState.SENT];

// A per-transfer progress snapshot + history/audit collections (small, additive).
const progressSchema = new mongoose.Schema({ transferId: { type: String, unique: true, index: true }, snapshot: mongoose.Schema.Types.Mixed }, { timestamps: true });
const TransferProgress = mongoose.models.TransferProgress || mongoose.model("TransferProgress", progressSchema);
const historySchema = new mongoose.Schema({ transferId: String, conversationId: { type: String, index: true }, state: String, at: String, detail: mongoose.Schema.Types.Mixed }, { timestamps: true });
const TransferHistory = mongoose.models.TransferHistory || mongoose.model("TransferHistory", historySchema);
const auditSchema = new mongoose.Schema({ transferId: String, kind: String, at: String, detail: mongoose.Schema.Types.Mixed }, { timestamps: true });
const TransferAudit = mongoose.models.TransferAudit || mongoose.model("TransferAudit", auditSchema);

export function createMongoTransportRepository(models = {}) {
  const TransferModel = models.TransferModel ?? Transfer;
  const ChunkModel = models.TransferChunkModel ?? TransferChunk;
  const ProgressModel = models.TransferProgressModel ?? TransferProgress;
  const HistoryModel = models.TransferHistoryModel ?? TransferHistory;
  const AuditModel = models.TransferAuditModel ?? TransferAudit;

  const transfers = {
    async create(t) {
      return stripMongo((await TransferModel.create(t)).toObject());
    },
    async findById(transferId) {
      return stripMongo(await TransferModel.findOne({ transferId: String(transferId) }).lean());
    },
    async update(transferId, patch) {
      const updated = await TransferModel.findOneAndUpdate({ transferId: String(transferId) }, patch, { new: true }).lean();
      if (!updated) throw new TransferNotFoundError("Transfer not found", { details: { transferId } });
      return stripMongo(updated);
    },
    async delete(transferId) {
      await ChunkModel.deleteMany({ transferId: String(transferId) });
      const res = await TransferModel.deleteOne({ transferId: String(transferId) });
      return res.deletedCount > 0;
    },
    async listActive(deviceId) {
      const filter = { state: { $in: ACTIVE_TRANSFER_STATES } };
      if (deviceId != null) filter.$or = [{ senderDeviceId: String(deviceId) }, { receiverDeviceId: String(deviceId) }];
      return (await TransferModel.find(filter).lean()).map(stripMongo);
    },
    async listByConversation(conversationId, options = {}) {
      const q = TransferModel.find({ conversationId: String(conversationId) }).sort({ createdAt: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
    async listByParticipant(deviceId, options = {}) {
      const filter = { $or: [{ senderDeviceId: String(deviceId) }, { receiverDeviceId: String(deviceId) }] };
      if (options.state) filter.state = options.state;
      const q = TransferModel.find(filter).sort({ createdAt: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
    async listExpired(nowIso) {
      const now = nowIso ?? new Date().toISOString();
      return (await TransferModel.find({ state: { $in: ACTIVE_TRANSFER_STATES }, expiresAt: { $lte: now } }).lean()).map(stripMongo);
    },
    async countByState() {
      const rows = await TransferModel.aggregate([{ $group: { _id: "$state", count: { $sum: 1 } } }]);
      const counts = {};
      for (const r of rows) counts[r._id] = r.count;
      return counts;
    },
  };

  const chunks = {
    async upsert(chunk) {
      if (!chunk?.chunkId || !chunk?.transferId) throw new ChunkValidationError("chunk requires { chunkId, transferId }");
      const doc = await ChunkModel.findOneAndUpdate({ chunkId: String(chunk.chunkId) }, { $set: chunk }, { new: true, upsert: true }).lean();
      return stripMongo(doc);
    },
    async findById(chunkId) {
      return stripMongo(await ChunkModel.findOne({ chunkId: String(chunkId) }).lean());
    },
    async findByTransfer(transferId, options = {}) {
      const filter = { transferId: String(transferId) };
      if (options.states) filter.state = { $in: options.states };
      return (await ChunkModel.find(filter).sort({ index: 1 }).lean()).map(stripMongo);
    },
    async update(chunkId, patch) {
      const updated = await ChunkModel.findOneAndUpdate({ chunkId: String(chunkId) }, patch, { new: true }).lean();
      if (!updated) throw new ChunkValidationError("Chunk not found", { details: { chunkId } });
      return stripMongo(updated);
    },
    async listRetryDue(transferId, nowIso) {
      const now = nowIso ?? new Date().toISOString();
      return (await ChunkModel.find({ transferId: String(transferId), state: { $in: RETRYABLE }, nextRetryAt: { $lte: now, $ne: null } }).sort({ index: 1 }).lean()).map(stripMongo);
    },
    async countByState(transferId) {
      const rows = await ChunkModel.aggregate([{ $match: { transferId: String(transferId) } }, { $group: { _id: "$state", count: { $sum: 1 } } }]);
      const counts = {};
      for (const r of rows) counts[r._id] = r.count;
      return counts;
    },
    async deleteByTransfer(transferId) {
      const res = await ChunkModel.deleteMany({ transferId: String(transferId) });
      return res.deletedCount ?? 0;
    },
  };

  const progress = {
    async save(transferId, snapshot) {
      const doc = await ProgressModel.findOneAndUpdate({ transferId: String(transferId) }, { $set: { snapshot } }, { new: true, upsert: true }).lean();
      return { transferId: String(transferId), ...stripMongo(doc).snapshot };
    },
    async get(transferId) {
      const doc = await ProgressModel.findOne({ transferId: String(transferId) }).lean();
      return doc ? { transferId: String(transferId), ...doc.snapshot } : null;
    },
  };

  const history = {
    async record(entry) {
      return stripMongo((await HistoryModel.create(entry)).toObject());
    },
    async listByConversation(conversationId, options = {}) {
      const q = HistoryModel.find({ conversationId: String(conversationId) }).sort({ at: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
  };

  const audit = {
    async record(entry) {
      return stripMongo((await AuditModel.create({ ...entry, at: entry.at ?? new Date().toISOString() })).toObject());
    },
    async list(options = {}) {
      const q = AuditModel.find({}).sort({ createdAt: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
  };

  return { transfers, chunks, progress, history, audit };
}

function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

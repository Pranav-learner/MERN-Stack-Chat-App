/**
 * @module media-delivery/repository/mongo
 *
 * MongoDB (Mongoose) media-delivery repositories. Mirror the in-memory contracts exactly, so the engine
 * is storage-independent. Store streaming sessions + transfers + previews + availability replicas +
 * offline queue only (no ciphertext or keys). Reads use `.lean()`.
 */

import StreamingSession from "../models/StreamingSession.model.js";
import DeliveryTransfer from "../models/DeliveryTransfer.model.js";
import MediaPreview from "../models/MediaPreview.model.js";
import { MediaAvailability, MediaOfflineQueue } from "../models/MediaAvailability.model.js";
import { SessionNotFoundError, TransferNotFoundError } from "../errors.js";

export function createMongoDeliveryRepository(models = {}) {
  const SessionModel = models.StreamingSessionModel ?? StreamingSession;
  const TransferModel = models.DeliveryTransferModel ?? DeliveryTransfer;
  const PreviewModel = models.MediaPreviewModel ?? MediaPreview;
  const AvailabilityModel = models.MediaAvailabilityModel ?? MediaAvailability;
  const QueueModel = models.MediaOfflineQueueModel ?? MediaOfflineQueue;

  const sessions = {
    async create(r) {
      return stripMongo((await SessionModel.create(r)).toObject());
    },
    async findById(sessionId) {
      return stripMongo(await SessionModel.findOne({ sessionId: String(sessionId) }).lean());
    },
    async update(sessionId, patch) {
      const u = await SessionModel.findOneAndUpdate({ sessionId: String(sessionId) }, { $set: patch }, { new: true }).lean();
      if (!u) throw new SessionNotFoundError("Session not found", { details: { sessionId } });
      return stripMongo(u);
    },
    async delete(sessionId) {
      return (await SessionModel.deleteOne({ sessionId: String(sessionId) })).deletedCount > 0;
    },
    async listByDevice(deviceId, { limit } = {}) {
      const q = SessionModel.find({ deviceId: String(deviceId) }).sort({ createdAt: -1 });
      if (limit) q.limit(limit);
      return (await q.lean()).map(stripMongo);
    },
    async listByMedia(mediaId) {
      return (await SessionModel.find({ mediaId: String(mediaId) }).lean()).map(stripMongo);
    },
  };

  const transfers = {
    async create(r) {
      return stripMongo((await TransferModel.create(r)).toObject());
    },
    async findById(transferId) {
      return stripMongo(await TransferModel.findOne({ transferId: String(transferId) }).lean());
    },
    async update(transferId, patch) {
      const u = await TransferModel.findOneAndUpdate({ transferId: String(transferId) }, { $set: patch }, { new: true }).lean();
      if (!u) throw new TransferNotFoundError("Transfer not found", { details: { transferId } });
      return stripMongo(u);
    },
    async delete(transferId) {
      return (await TransferModel.deleteOne({ transferId: String(transferId) })).deletedCount > 0;
    },
    async listByDevice(deviceId, { state, limit } = {}) {
      const q = { deviceId: String(deviceId) };
      if (state) q.state = state;
      const cursor = TransferModel.find(q).sort({ createdAt: -1 });
      if (limit) cursor.limit(limit);
      return (await cursor.lean()).map(stripMongo);
    },
    async listByMedia(mediaId) {
      return (await TransferModel.find({ mediaId: String(mediaId) }).lean()).map(stripMongo);
    },
  };

  const previews = {
    async create(record) {
      return stripMongo((await PreviewModel.create(record)).toObject());
    },
    async findById(previewId) {
      return stripMongo(await PreviewModel.findOne({ previewId: String(previewId) }).lean());
    },
    async findByMediaKind(mediaId, kind) {
      return stripMongo(await PreviewModel.findOne({ mediaId: String(mediaId), kind }).lean());
    },
    async update(previewId, patch) {
      return stripMongo(await PreviewModel.findOneAndUpdate({ previewId: String(previewId) }, { $set: patch }, { new: true }).lean());
    },
    async listByMedia(mediaId) {
      return (await PreviewModel.find({ mediaId: String(mediaId) }).lean()).map(stripMongo);
    },
  };

  const availability = {
    async upsert(replica) {
      return stripMongo(await AvailabilityModel.findOneAndUpdate({ deviceId: String(replica.deviceId) }, { $set: replica }, { new: true, upsert: true }).lean());
    },
    async findByDevice(deviceId) {
      return stripMongo(await AvailabilityModel.findOne({ deviceId: String(deviceId) }).lean());
    },
    async enqueueOffline(entry) {
      const doc = await QueueModel.findOneAndUpdate({ deviceId: String(entry.deviceId), mediaId: String(entry.mediaId) }, { $set: { priority: entry.priority ?? "normal", at: entry.at ?? new Date().toISOString() } }, { new: true, upsert: true }).lean();
      return stripMongo(doc);
    },
    async listOffline(deviceId) {
      return (await QueueModel.find({ deviceId: String(deviceId) }).lean()).map(stripMongo);
    },
    async drainOffline(deviceId) {
      const docs = await QueueModel.find({ deviceId: String(deviceId) }).lean();
      await QueueModel.deleteMany({ deviceId: String(deviceId) });
      return docs.map(stripMongo);
    },
    async countOffline(deviceId) {
      return QueueModel.countDocuments({ deviceId: String(deviceId) });
    },
  };

  const audit = {
    async record() {
      return null; // delivery audit is emitted via events; a deployment can add a sink here
    },
    async list() {
      return [];
    },
  };

  return { sessions, transfers, previews, availability, audit };
}

function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

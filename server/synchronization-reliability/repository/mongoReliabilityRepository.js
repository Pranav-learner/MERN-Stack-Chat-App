/**
 * @module synchronization-reliability/repository/mongo
 *
 * MongoDB (Mongoose) reliability repositories. Mirror the in-memory contracts. Store reliability
 * control-plane metadata + checkpoints only — no content / key field. Reads use `.lean()`.
 */

import SyncReliability from "../models/SyncReliability.model.js";
import SyncRecoveryRecord from "../models/SyncRecoveryRecord.model.js";
import SyncReliabilityAlert from "../models/SyncReliabilityAlert.model.js";
import { SyncRecordNotFoundError } from "../errors.js";
import { ACTIVE_RELIABILITY_STATES } from "../types/types.js";

const STALLABLE = ["tracking", "degraded"];

export function createMongoReliabilityRepository(models = {}) {
  const RecordModel = models.SyncReliabilityModel ?? SyncReliability;
  const RecoveryModel = models.SyncRecoveryRecordModel ?? SyncRecoveryRecord;
  const AlertModel = models.SyncReliabilityAlertModel ?? SyncReliabilityAlert;

  const records = {
    async create(r) {
      return stripMongo((await RecordModel.create(r)).toObject());
    },
    async findById(syncId) {
      return stripMongo(await RecordModel.findOne({ syncId: String(syncId) }).lean());
    },
    async update(syncId, patch) {
      const updated = await RecordModel.findOneAndUpdate({ syncId: String(syncId) }, patch, { new: true }).lean();
      if (!updated) throw new SyncRecordNotFoundError("Sync reliability record not found", { details: { syncId } });
      return stripMongo(updated);
    },
    async delete(syncId) {
      const res = await RecordModel.deleteOne({ syncId: String(syncId) });
      return res.deletedCount > 0;
    },
    async listActive(deviceId) {
      const filter = { state: { $in: ACTIVE_RELIABILITY_STATES } };
      if (deviceId != null) filter.$or = [{ deviceId: String(deviceId) }, { userId: String(deviceId) }];
      return (await RecordModel.find(filter).lean()).map(stripMongo);
    },
    async listByUser(userId, options = {}) {
      const filter = { $or: [{ userId: String(userId) }, { deviceId: String(userId) }] };
      if (options.state) filter.state = options.state;
      const q = RecordModel.find(filter).sort({ registeredAt: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
    async listStalled(now, timeoutMs) {
      const cutoffIso = new Date(Number(now ?? Date.now()) - timeoutMs).toISOString();
      return (await RecordModel.find({ state: { $in: STALLABLE }, lastActivityAt: { $lte: cutoffIso } }).lean()).map(stripMongo);
    },
    async listExpired(nowIso) {
      const now = nowIso ?? new Date().toISOString();
      return (await RecordModel.find({ state: { $in: ACTIVE_RELIABILITY_STATES }, expiresAt: { $lte: now } }).lean()).map(stripMongo);
    },
    async countByState() {
      const rows = await RecordModel.aggregate([{ $group: { _id: "$state", count: { $sum: 1 } } }]);
      const counts = {};
      for (const r of rows) counts[r._id] = r.count;
      return counts;
    },
  };

  const recoveryHistory = {
    async record(entry) {
      return stripMongo((await RecoveryModel.create({ ...entry, at: entry.at ?? new Date().toISOString() })).toObject());
    },
    async listBySync(syncId, options = {}) {
      const q = RecoveryModel.find({ syncId: String(syncId) }).sort({ at: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
  };

  const alerts = {
    async record(alert) {
      return stripMongo((await AlertModel.create(alert)).toObject());
    },
    async list(options = {}) {
      const total = await AlertModel.estimatedDocumentCount();
      const q = AlertModel.find({}).sort({ at: -1 });
      if (options.offset) q.skip(options.offset);
      q.limit(options.limit ?? 50);
      return { total, alerts: (await q.lean()).map(stripMongo) };
    },
  };

  const audit = {
    async record(entry) {
      return entry;
    },
    async list() {
      return [];
    },
  };

  return { records, recoveryHistory, alerts, audit };
}

function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

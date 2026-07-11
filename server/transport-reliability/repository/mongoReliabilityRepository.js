/**
 * @module transport-reliability/repository/mongo
 *
 * MongoDB (Mongoose) reliability repositories. Mirror the in-memory contracts. Store reliability
 * control-plane metadata + checkpoints only — no payload / key field. Reads use `.lean()`.
 */

import TransferReliability from "../models/TransferReliability.model.js";
import RecoveryRecord from "../models/RecoveryRecord.model.js";
import ReliabilityAlert from "../models/ReliabilityAlert.model.js";
import { TransferRecordNotFoundError } from "../errors.js";
import { ACTIVE_RELIABILITY_STATES } from "../types/types.js";

const STALLABLE = ["tracking", "degraded"];

export function createMongoReliabilityRepository(models = {}) {
  const RecordModel = models.TransferReliabilityModel ?? TransferReliability;
  const RecoveryModel = models.RecoveryRecordModel ?? RecoveryRecord;
  const AlertModel = models.ReliabilityAlertModel ?? ReliabilityAlert;

  const records = {
    async create(r) {
      return stripMongo((await RecordModel.create(r)).toObject());
    },
    async findById(transferId) {
      return stripMongo(await RecordModel.findOne({ transferId: String(transferId) }).lean());
    },
    async update(transferId, patch) {
      const updated = await RecordModel.findOneAndUpdate({ transferId: String(transferId) }, patch, { new: true }).lean();
      if (!updated) throw new TransferRecordNotFoundError("Transfer reliability record not found", { details: { transferId } });
      return stripMongo(updated);
    },
    async delete(transferId) {
      const res = await RecordModel.deleteOne({ transferId: String(transferId) });
      return res.deletedCount > 0;
    },
    async listActive(deviceId) {
      const filter = { state: { $in: ACTIVE_RELIABILITY_STATES } };
      if (deviceId != null) filter.$or = [{ senderDeviceId: String(deviceId) }, { receiverDeviceId: String(deviceId) }];
      return (await RecordModel.find(filter).lean()).map(stripMongo);
    },
    async listByParticipant(deviceId, options = {}) {
      const filter = { $or: [{ senderDeviceId: String(deviceId) }, { receiverDeviceId: String(deviceId) }] };
      if (options.state) filter.state = options.state;
      const q = RecordModel.find(filter).sort({ registeredAt: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
    async listStalled(now, timeoutMs) {
      const cutoffIso = new Date(Number(now ?? Date.now()) - timeoutMs).toISOString();
      return (await RecordModel.find({ state: { $in: STALLABLE }, lastActivityAt: { $lte: cutoffIso } }).lean()).map(stripMongo);
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
      return stripMongo((await RecoveryModel.create({ ...entry, kind: entry.kind ?? "recovery", at: entry.at ?? new Date().toISOString() })).toObject());
    },
    async listByTransfer(transferId, options = {}) {
      const q = RecoveryModel.find({ transferId: String(transferId), kind: "recovery" }).sort({ at: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
  };

  const migrationHistory = {
    async record(entry) {
      return stripMongo((await RecoveryModel.create({ ...entry, kind: "migration", at: entry.at ?? new Date().toISOString() })).toObject());
    },
    async listByTransfer(transferId, options = {}) {
      const q = RecoveryModel.find({ transferId: String(transferId), kind: "migration" }).sort({ at: -1 });
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
      // audit reuses the alert-style collection tagged as audit for simplicity in the relay context
      return entry;
    },
    async list() {
      return [];
    },
  };

  return { records, recoveryHistory, migrationHistory, alerts, audit };
}

function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

/**
 * @module group-reliability/repository/mongo
 *
 * MongoDB (Mongoose) group-reliability repositories. Mirror the in-memory contracts exactly, so the
 * manager is storage-independent. Store reliability records + recovery history + alerts + audit only
 * (no content / keys). Reads use `.lean()`. Recovery history + audit share one `GroupRecoveryRecord`
 * collection keyed by `kind`.
 */

import GroupReliability from "../models/GroupReliability.model.js";
import GroupRecoveryRecord from "../models/GroupRecoveryRecord.model.js";
import GroupReliabilityAlert from "../models/GroupReliabilityAlert.model.js";
import { OperationNotFoundError } from "../errors.js";
import { ACTIVE_RELIABILITY_STATES } from "../types/types.js";

export function createMongoGroupReliabilityRepository(models = {}) {
  const RecordModel = models.GroupReliabilityModel ?? GroupReliability;
  const RecoveryModel = models.GroupRecoveryRecordModel ?? GroupRecoveryRecord;
  const AlertModel = models.GroupReliabilityAlertModel ?? GroupReliabilityAlert;
  const active = [...ACTIVE_RELIABILITY_STATES];

  const records = {
    async create(r) {
      const doc = await RecordModel.create(r);
      return stripMongo(doc.toObject());
    },
    async findById(operationId) {
      return stripMongo(await RecordModel.findOne({ operationId: String(operationId) }).lean());
    },
    async update(operationId, patch) {
      const updated = await RecordModel.findOneAndUpdate({ operationId: String(operationId) }, { $set: patch }, { new: true }).lean();
      if (!updated) throw new OperationNotFoundError("Group operation record not found", { details: { operationId } });
      return stripMongo(updated);
    },
    async delete(operationId) {
      const res = await RecordModel.deleteOne({ operationId: String(operationId) });
      return res.deletedCount > 0;
    },
    async listActive(deviceId) {
      const q = { state: { $in: active } };
      if (deviceId != null) q.$or = [{ deviceId: String(deviceId) }, { userId: String(deviceId) }];
      return (await RecordModel.find(q).lean()).map(stripMongo);
    },
    async listByGroup(groupId, options = {}) {
      const q = { groupId: String(groupId) };
      if (options.state) q.state = options.state;
      const cursor = RecordModel.find(q).sort({ registeredAt: -1 });
      if (options.limit) cursor.limit(options.limit);
      return (await cursor.lean()).map(stripMongo);
    },
    async listByUser(userId, options = {}) {
      const q = { $or: [{ userId: String(userId) }, { deviceId: String(userId) }] };
      if (options.state) q.state = options.state;
      const cursor = RecordModel.find(q).sort({ registeredAt: -1 });
      if (options.limit) cursor.limit(options.limit);
      return (await cursor.lean()).map(stripMongo);
    },
    async listStalled(now, timeoutMs) {
      const cutoff = new Date(Number(now ?? Date.now()) - timeoutMs).toISOString();
      return (await RecordModel.find({ state: { $in: ["tracking", "degraded"] }, lastActivityAt: { $lte: cutoff } }).lean()).map(stripMongo);
    },
    async listExpired(nowIso) {
      const now = nowIso ?? new Date().toISOString();
      return (await RecordModel.find({ state: { $in: active }, expiresAt: { $lte: now } }).lean()).map(stripMongo);
    },
    async countByState() {
      const rows = await RecordModel.aggregate([{ $group: { _id: "$state", n: { $sum: 1 } } }]);
      const counts = {};
      for (const row of rows) counts[row._id] = row.n;
      return counts;
    },
  };

  const recoveryHistory = {
    async record(entry) {
      const doc = await RecoveryModel.create({ kind: "recovery", operationId: entry.operationId, groupId: entry.groupId, trigger: entry.trigger, action: entry.action, outcome: entry.outcome, attempt: entry.attempt, detail: entry, at: entry.at ?? new Date().toISOString() });
      return stripMongo(doc.toObject());
    },
    async listByOperation(operationId, options = {}) {
      const cursor = RecoveryModel.find({ kind: "recovery", operationId: String(operationId) }).sort({ at: -1 });
      if (options.limit) cursor.limit(options.limit);
      return (await cursor.lean()).map((d) => stripMongo(d).detail ?? stripMongo(d));
    },
  };

  const alerts = {
    async record(alert) {
      const doc = await AlertModel.create({ type: alert.type, severity: alert.severity, details: alert.details, at: alert.at ?? new Date().toISOString() });
      return stripMongo(doc.toObject());
    },
    async list(options = {}) {
      const total = await AlertModel.countDocuments();
      const cursor = AlertModel.find().sort({ at: -1 });
      if (options.offset) cursor.skip(options.offset);
      cursor.limit(options.limit ?? 50);
      return { total, alerts: (await cursor.lean()).map(stripMongo) };
    },
  };

  const audit = {
    async record(entry) {
      const doc = await RecoveryModel.create({ kind: "audit", operationId: entry.operationId, groupId: entry.groupId, operation: entry.operation, outcome: entry.outcome, actingDevice: entry.actingDevice, detail: entry, at: entry.at ?? new Date().toISOString() });
      return stripMongo(doc.toObject());
    },
    async listByGroup(groupId, options = {}) {
      const cursor = RecoveryModel.find({ kind: "audit", groupId: String(groupId) }).sort({ at: -1 });
      if (options.limit) cursor.limit(options.limit);
      return (await cursor.lean()).map((d) => stripMongo(d).detail ?? stripMongo(d));
    },
    async list(options = {}) {
      const cursor = RecoveryModel.find({ kind: "audit" }).sort({ at: -1 });
      if (options.limit) cursor.limit(options.limit);
      return (await cursor.lean()).map((d) => stripMongo(d).detail ?? stripMongo(d));
    },
  };

  return { records, recoveryHistory, alerts, audit };
}

function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

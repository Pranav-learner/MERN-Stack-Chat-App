/**
 * @module synchronization/repository/mongo
 *
 * MongoDB (Mongoose) synchronization repositories. Mirror the in-memory contracts. Store replica
 * version maps + session/plan metadata only — no plaintext / key field. Reads use `.lean()`.
 */

import Replica from "../models/Replica.model.js";
import SyncSession from "../models/SyncSession.model.js";
import SyncPlan from "../models/SyncPlan.model.js";
import { ReplicaNotFoundError, SessionNotFoundError } from "../errors.js";
import { ACTIVE_SESSION_STATES } from "../types/types.js";
import mongoose from "mongoose";

// Small delta-history + audit collections (additive).
const deltaSchema = new mongoose.Schema({ sessionId: { type: String, index: true }, sourceReplicaId: String, targetReplicaId: String, totalItems: Number, byCategory: mongoose.Schema.Types.Mixed, at: String }, { timestamps: true });
const SyncDeltaHistory = mongoose.models.SyncDeltaHistory || mongoose.model("SyncDeltaHistory", deltaSchema);
const auditSchema = new mongoose.Schema({ sessionId: String, operation: String, actingDevice: String, outcome: String, at: String, detail: mongoose.Schema.Types.Mixed }, { timestamps: true });
const SyncAudit = mongoose.models.SyncAudit || mongoose.model("SyncAudit", auditSchema);
const progressSchema = new mongoose.Schema({ sessionId: { type: String, unique: true, index: true }, snapshot: mongoose.Schema.Types.Mixed }, { timestamps: true });
const SyncProgress = mongoose.models.SyncProgress || mongoose.model("SyncProgress", progressSchema);

export function createMongoSyncRepository(models = {}) {
  const ReplicaModel = models.ReplicaModel ?? Replica;
  const SessionModel = models.SyncSessionModel ?? SyncSession;
  const PlanModel = models.SyncPlanModel ?? SyncPlan;
  const DeltaModel = models.SyncDeltaHistoryModel ?? SyncDeltaHistory;
  const AuditModel = models.SyncAuditModel ?? SyncAudit;
  const ProgressModel = models.SyncProgressModel ?? SyncProgress;

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
  };

  const sessions = {
    async create(s) {
      return stripMongo((await SessionModel.create(s)).toObject());
    },
    async findById(sessionId) {
      return stripMongo(await SessionModel.findOne({ sessionId: String(sessionId) }).lean());
    },
    async update(sessionId, patch) {
      const updated = await SessionModel.findOneAndUpdate({ sessionId: String(sessionId) }, patch, { new: true }).lean();
      if (!updated) throw new SessionNotFoundError("Synchronization session not found", { details: { sessionId } });
      return stripMongo(updated);
    },
    async delete(sessionId) {
      await PlanModel.deleteOne({ sessionId: String(sessionId) });
      const res = await SessionModel.deleteOne({ sessionId: String(sessionId) });
      return res.deletedCount > 0;
    },
    async listActive(filter = {}) {
      const q = { state: { $in: ACTIVE_SESSION_STATES } };
      if (filter.deviceId) q.deviceId = String(filter.deviceId);
      if (filter.userId) q.userId = String(filter.userId);
      return (await SessionModel.find(q).sort({ createdAt: -1 }).lean()).map(stripMongo);
    },
    async listByReplica(replicaId, options = {}) {
      const q = SessionModel.find({ $or: [{ sourceReplicaId: String(replicaId) }, { targetReplicaId: String(replicaId) }] }).sort({ createdAt: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
    async listExpired(nowIso) {
      const now = nowIso ?? new Date().toISOString();
      return (await SessionModel.find({ state: { $in: ACTIVE_SESSION_STATES }, expiresAt: { $lte: now } }).lean()).map(stripMongo);
    },
    async countByState() {
      const rows = await SessionModel.aggregate([{ $group: { _id: "$state", count: { $sum: 1 } } }]);
      const counts = {};
      for (const r of rows) counts[r._id] = r.count;
      return counts;
    },
  };

  const plans = {
    async save(sessionId, plan) {
      const doc = await PlanModel.findOneAndUpdate({ sessionId: String(sessionId) }, { $set: plan }, { new: true, upsert: true }).lean();
      return stripMongo(doc);
    },
    async get(sessionId) {
      return stripMongo(await PlanModel.findOne({ sessionId: String(sessionId) }).lean());
    },
    async findById(sessionId) {
      return plans.get(sessionId);
    },
  };

  const deltaHistory = {
    async record(entry) {
      return stripMongo((await DeltaModel.create({ ...entry, at: entry.at ?? new Date().toISOString() })).toObject());
    },
    async listBySession(sessionId, options = {}) {
      const q = DeltaModel.find({ sessionId: String(sessionId) }).sort({ at: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
  };

  const progress = {
    async save(sessionId, snapshot) {
      const doc = await ProgressModel.findOneAndUpdate({ sessionId: String(sessionId) }, { $set: { snapshot } }, { new: true, upsert: true }).lean();
      return { sessionId: String(sessionId), ...stripMongo(doc).snapshot };
    },
    async get(sessionId) {
      const doc = await ProgressModel.findOne({ sessionId: String(sessionId) }).lean();
      return doc ? { sessionId: String(sessionId), ...doc.snapshot } : null;
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

  return { replicas, sessions, plans, deltaHistory, progress, audit };
}

function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

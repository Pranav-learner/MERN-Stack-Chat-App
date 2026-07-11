/**
 * @module network-reliability/repository/mongo
 *
 * MongoDB (Mongoose) Network Reliability repositories. Mirror the in-memory contracts. Store
 * CONTROL-PLANE metadata only — no field for a private key or shared secret. Reads use `.lean()`.
 */

import ActiveConnection from "../models/ActiveConnection.model.js";
import RecoveryRecord from "../models/RecoveryRecord.model.js";
import ReliabilityAlert from "../models/ReliabilityAlert.model.js";
import { ConnectionNotFoundError } from "../errors.js";
import { LIVE_CONNECTION_STATES, ConnectionState } from "../types/types.js";

const SWEEPABLE = [...LIVE_CONNECTION_STATES, ConnectionState.CONNECTING, ConnectionState.RECONNECTING];

/**
 * @param {{ ActiveConnectionModel?: import("mongoose").Model, RecoveryRecordModel?: import("mongoose").Model, ReliabilityAlertModel?: import("mongoose").Model }} [models]
 * @returns {{ connections: object, recovery: object, alerts: object }}
 */
export function createMongoReliabilityRepository(models = {}) {
  const ConnModel = models.ActiveConnectionModel ?? ActiveConnection;
  const RecModel = models.RecoveryRecordModel ?? RecoveryRecord;
  const AlertModel = models.ReliabilityAlertModel ?? ReliabilityAlert;

  const connections = {
    async create(conn) {
      const doc = await ConnModel.findOneAndUpdate(
        { deviceId: String(conn.deviceId), peerId: String(conn.peerId) },
        { $set: conn },
        { new: true, upsert: true },
      ).lean();
      return stripMongo(doc);
    },
    async findById(connectionId) {
      return stripMongo(await ConnModel.findOne({ connectionId: String(connectionId) }).lean());
    },
    async findByDeviceAndPeer(deviceId, peerId) {
      return stripMongo(await ConnModel.findOne({ deviceId: String(deviceId), peerId: String(peerId) }).lean());
    },
    async update(connectionId, patch) {
      const updated = await ConnModel.findOneAndUpdate({ connectionId: String(connectionId) }, patch, { new: true }).lean();
      if (!updated) throw new ConnectionNotFoundError("Active connection not found", { details: { connectionId } });
      return stripMongo(updated);
    },
    async delete(connectionId) {
      const res = await ConnModel.deleteOne({ connectionId: String(connectionId) });
      return res.deletedCount > 0;
    },
    async listByDevice(deviceId, options = {}) {
      const q = ConnModel.find({ deviceId: String(deviceId) }).sort({ establishedAt: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
    async listLive() {
      return (await ConnModel.find({ state: { $in: LIVE_CONNECTION_STATES } }).lean()).map(stripMongo);
    },
    async listTimedOut(nowIso) {
      const now = nowIso ?? new Date().toISOString();
      return (await ConnModel.find({ state: { $in: SWEEPABLE }, heartbeatExpiresAt: { $lte: now } }).lean()).map(stripMongo);
    },
    async countByState() {
      const rows = await ConnModel.aggregate([{ $group: { _id: "$state", count: { $sum: 1 } } }]);
      const counts = {};
      for (const r of rows) counts[r._id] = r.count;
      return counts;
    },
  };

  const recovery = {
    async record(rec) {
      const doc = await RecModel.create(rec);
      return stripMongo(doc.toObject());
    },
    async listByConnection(connectionId, options = {}) {
      const q = RecModel.find({ connectionId: String(connectionId) }).sort({ at: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
  };

  const alerts = {
    async record(alert) {
      const doc = await AlertModel.create(alert);
      return stripMongo(doc.toObject());
    },
    async list(options = {}) {
      const filter = {};
      if (options.alertType) filter.alertType = options.alertType;
      const q = AlertModel.find(filter).sort({ at: -1 });
      if (options.offset) q.skip(options.offset);
      q.limit(options.limit ?? 50);
      return (await q.lean()).map(stripMongo);
    },
    async count(options = {}) {
      const filter = {};
      if (options.alertType) filter.alertType = options.alertType;
      return AlertModel.countDocuments(filter);
    },
  };

  return { connections, recovery, alerts };
}

function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

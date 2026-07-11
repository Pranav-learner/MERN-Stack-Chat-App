/**
 * @module presence/repository/mongo
 *
 * MongoDB (Mongoose) Presence repository. Mirrors the contract in
 * {@link module:presence/repository/inMemory}. Stores presence CONTROL-PLANE metadata only —
 * no field for a private key, session key, or shared secret. Reads use `.lean()`. Keyed on
 * `presenceId`, with a unique `(userId, deviceId)` pairing.
 */

import PresenceRecord from "../models/PresenceRecord.model.js";
import { PresenceNotFoundError } from "../errors.js";
import { REACHABLE_PRESENCE_STATUSES, PresenceStatus } from "../types/types.js";

const SWEEPABLE = [...REACHABLE_PRESENCE_STATUSES, PresenceStatus.RECONNECTING, PresenceStatus.DISCONNECTED];

/**
 * @param {{ PresenceRecordModel?: import("mongoose").Model }} [models]
 * @returns {{ presence: object }}
 */
export function createMongoPresenceRepository(models = {}) {
  const Model = models.PresenceRecordModel ?? PresenceRecord;

  const presence = {
    async upsert(record) {
      const doc = await Model.findOneAndUpdate(
        { userId: String(record.userId), deviceId: String(record.deviceId) },
        { $set: record },
        { new: true, upsert: true },
      ).lean();
      return stripMongo(doc);
    },
    async create(record) {
      const doc = await Model.create(record);
      return stripMongo(doc.toObject());
    },
    async findById(presenceId) {
      return stripMongo(await Model.findOne({ presenceId: String(presenceId) }).lean());
    },
    async findByUserAndDevice(userId, deviceId) {
      return stripMongo(await Model.findOne({ userId: String(userId), deviceId: String(deviceId) }).lean());
    },
    async findByUser(userId) {
      return (await Model.find({ userId: String(userId) }).lean()).map(stripMongo);
    },
    async update(presenceId, patch) {
      const updated = await Model.findOneAndUpdate({ presenceId: String(presenceId) }, patch, { new: true }).lean();
      if (!updated) throw new PresenceNotFoundError("Presence record not found", { details: { presenceId } });
      return stripMongo(updated);
    },
    async delete(presenceId) {
      const res = await Model.deleteOne({ presenceId: String(presenceId) });
      return res.deletedCount > 0;
    },
    async listByStatus(status) {
      return (await Model.find({ status }).lean()).map(stripMongo);
    },
    async listReachableByUser(userId) {
      return (await Model.find({ userId: String(userId), status: { $in: REACHABLE_PRESENCE_STATUSES } }).lean()).map(stripMongo);
    },
    async listExpired(nowIso) {
      const now = nowIso ?? new Date().toISOString();
      return (await Model.find({ status: { $in: SWEEPABLE }, expiresAt: { $lte: now } }).lean()).map(stripMongo);
    },
    async countByStatus() {
      const rows = await Model.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]);
      const counts = {};
      for (const row of rows) counts[row._id] = row.count;
      return counts;
    },
    async listAll() {
      return (await Model.find({}).lean()).map(stripMongo);
    },
  };

  return { presence };
}

/** Drop Mongo bookkeeping fields so DTOs stay clean + framework-owned. */
function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

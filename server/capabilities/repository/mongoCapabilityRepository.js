/**
 * @module capabilities/repository/mongo
 *
 * MongoDB (Mongoose) Capability repositories. Mirrors the contract in
 * {@link module:capabilities/repository/inMemory}. Stores capability CONTROL-PLANE metadata only —
 * no field for a private key, session key, or shared secret. Reads use `.lean()`.
 */

import CapabilitySet from "../models/CapabilitySet.model.js";
import NegotiationRecord from "../models/NegotiationRecord.model.js";
import { CapabilityNotFoundError } from "../errors.js";
import { NEGOTIABLE_CAPABILITY_STATES } from "../types/types.js";

/**
 * @param {{ CapabilitySetModel?: import("mongoose").Model, NegotiationRecordModel?: import("mongoose").Model }} [models]
 * @returns {{ capabilities: object, negotiations: object }}
 */
export function createMongoCapabilityRepository(models = {}) {
  const CapModel = models.CapabilitySetModel ?? CapabilitySet;
  const NegModel = models.NegotiationRecordModel ?? NegotiationRecord;

  const capabilities = {
    async upsert(record) {
      const doc = await CapModel.findOneAndUpdate(
        { userId: String(record.userId), deviceId: String(record.deviceId) },
        { $set: record },
        { new: true, upsert: true },
      ).lean();
      return stripMongo(doc);
    },
    async create(record) {
      const doc = await CapModel.create(record);
      return stripMongo(doc.toObject());
    },
    async findById(capabilityId) {
      return stripMongo(await CapModel.findOne({ capabilityId: String(capabilityId) }).lean());
    },
    async findByUserAndDevice(userId, deviceId) {
      return stripMongo(await CapModel.findOne({ userId: String(userId), deviceId: String(deviceId) }).lean());
    },
    async findByUser(userId) {
      return (await CapModel.find({ userId: String(userId) }).lean()).map(stripMongo);
    },
    async update(capabilityId, patch) {
      const updated = await CapModel.findOneAndUpdate({ capabilityId: String(capabilityId) }, patch, { new: true }).lean();
      if (!updated) throw new CapabilityNotFoundError("Capability set not found", { details: { capabilityId } });
      return stripMongo(updated);
    },
    async delete(capabilityId) {
      const res = await CapModel.deleteOne({ capabilityId: String(capabilityId) });
      return res.deletedCount > 0;
    },
    async listByState(state) {
      return (await CapModel.find({ state }).lean()).map(stripMongo);
    },
    async listExpired(nowIso) {
      const now = nowIso ?? new Date().toISOString();
      return (await CapModel.find({ state: { $in: NEGOTIABLE_CAPABILITY_STATES }, expiresAt: { $lte: now } }).lean()).map(stripMongo);
    },
    async countByState() {
      const rows = await CapModel.aggregate([{ $group: { _id: "$state", count: { $sum: 1 } } }]);
      const counts = {};
      for (const row of rows) counts[row._id] = row.count;
      return counts;
    },
    async listAll() {
      return (await CapModel.find({}).lean()).map(stripMongo);
    },
  };

  const negotiations = {
    async record(negotiation) {
      const doc = await NegModel.create(negotiation);
      return stripMongo(doc.toObject());
    },
    async findById(negotiationId) {
      return stripMongo(await NegModel.findOne({ negotiationId: String(negotiationId) }).lean());
    },
    async listByDevice(userId, deviceId, options = {}) {
      const q = NegModel.find({
        $or: [
          { requester: String(userId), requesterDevice: String(deviceId) },
          { targetUser: String(userId), targetDevice: String(deviceId) },
        ],
      }).sort({ createdAt: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
    async listByPair(userId, deviceId, targetUser, targetDevice, options = {}) {
      const q = NegModel.find({
        $or: [
          { requester: String(userId), requesterDevice: String(deviceId), targetUser: String(targetUser), targetDevice: String(targetDevice) },
          { requester: String(targetUser), requesterDevice: String(targetDevice), targetUser: String(userId), targetDevice: String(deviceId) },
        ],
      }).sort({ createdAt: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
    async listAll() {
      return (await NegModel.find({}).lean()).map(stripMongo);
    },
  };

  return { capabilities, negotiations };
}

/** Drop Mongo bookkeeping fields so DTOs stay clean + framework-owned. */
function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, updatedAt, ...rest } = doc;
  return rest;
}

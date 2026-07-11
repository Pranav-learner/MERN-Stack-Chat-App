/**
 * @module peer-discovery/repository/mongo
 *
 * MongoDB (Mongoose) Discovery repositories. Mirrors the contract in
 * {@link module:peer-discovery/repository/inMemory}. Stores discovery CONTROL-PLANE
 * metadata only — no field for a private key, session key, or shared secret. Reads use
 * `.lean()`. The session store keys on `discoveryId`; the registry store keys on
 * `(userId, deviceId)`.
 */

import DiscoverySession from "../models/DiscoverySession.model.js";
import DiscoveryRegistryEntry from "../models/DiscoveryRegistryEntry.model.js";
import { DiscoveryNotFoundError } from "../errors.js";
import { ACTIVE_DISCOVERY_STATES } from "../types/types.js";
import { discoveryDedupeKey } from "../session/discoverySession.js";

/**
 * @param {{ DiscoverySessionModel?: import("mongoose").Model, DiscoveryRegistryEntryModel?: import("mongoose").Model }} [models]
 * @returns {{ sessions: object, registry: object }}
 */
export function createMongoDiscoveryRepository(models = {}) {
  const SessionModel = models.DiscoverySessionModel ?? DiscoverySession;
  const RegistryModel = models.DiscoveryRegistryEntryModel ?? DiscoveryRegistryEntry;

  const sessions = {
    async create(session) {
      const doc = await SessionModel.create({ ...session, dedupeKey: discoveryDedupeKey(session) });
      return stripMongo(doc.toObject());
    },
    async findById(discoveryId) {
      return stripMongo(await SessionModel.findOne({ discoveryId: String(discoveryId) }).lean());
    },
    async update(discoveryId, patch) {
      // Keep the denormalized dedupeKey consistent if the identity of the lookup changed.
      const updated = await SessionModel.findOneAndUpdate(
        { discoveryId: String(discoveryId) },
        patch,
        { new: true },
      ).lean();
      if (!updated) throw new DiscoveryNotFoundError("Discovery session not found", { details: { discoveryId } });
      return stripMongo(updated);
    },
    async delete(discoveryId) {
      const res = await SessionModel.deleteOne({ discoveryId: String(discoveryId) });
      return res.deletedCount > 0;
    },
    async findActiveByDedupeKey(dedupeKey) {
      return stripMongo(
        await SessionModel.findOne({ dedupeKey, state: { $in: ACTIVE_DISCOVERY_STATES } })
          .sort({ createdAt: -1 })
          .lean(),
      );
    },
    async listByRequester(requester, options = {}) {
      const filter = { requester: String(requester) };
      if (options.activeOnly) filter.state = { $in: ACTIVE_DISCOVERY_STATES };
      return (await SessionModel.find(filter).sort({ createdAt: -1 }).lean()).map(stripMongo);
    },
    async listByState(state) {
      return (await SessionModel.find({ state }).lean()).map(stripMongo);
    },
    async listExpired(nowIso) {
      const now = nowIso ?? new Date().toISOString();
      return (
        await SessionModel.find({ state: { $in: ACTIVE_DISCOVERY_STATES }, expiresAt: { $lte: now } }).lean()
      ).map(stripMongo);
    },
  };

  const registry = {
    async upsert(descriptor) {
      const { userId, deviceId } = descriptor;
      const existing = await RegistryModel.findOne({ userId: String(userId), deviceId: String(deviceId) }).lean();
      const doc = await RegistryModel.findOneAndUpdate(
        { userId: String(userId), deviceId: String(deviceId) },
        {
          $set: { ...descriptor, version: (existing?.version ?? 0) + 1 },
          $setOnInsert: { registeredAt: descriptor.registeredAt ?? new Date().toISOString() },
        },
        { new: true, upsert: true },
      ).lean();
      return stripMongo(doc);
    },
    async findByUser(userId) {
      return (await RegistryModel.find({ userId: String(userId) }).lean()).map(stripMongo);
    },
    async findByUserAndDevice(userId, deviceId) {
      return stripMongo(
        await RegistryModel.findOne({ userId: String(userId), deviceId: String(deviceId) }).lean(),
      );
    },
    async remove(userId, deviceId) {
      const res = await RegistryModel.deleteOne({ userId: String(userId), deviceId: String(deviceId) });
      return res.deletedCount > 0;
    },
    async removeByUser(userId) {
      const res = await RegistryModel.deleteMany({ userId: String(userId) });
      return res.deletedCount ?? 0;
    },
    async listAll() {
      return (await RegistryModel.find({}).lean()).map(stripMongo);
    },
  };

  return { sessions, registry };
}

/** Drop Mongo bookkeeping fields so DTOs stay clean + framework-owned. */
function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, ...rest } = doc;
  return rest;
}

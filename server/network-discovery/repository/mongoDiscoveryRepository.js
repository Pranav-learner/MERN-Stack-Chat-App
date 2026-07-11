/**
 * @module network-discovery/repository/mongo
 *
 * MongoDB (Mongoose) Network Discovery repositories. Mirrors the in-memory contract. Stores PUBLIC
 * network metadata only — no field for a private key or shared secret. Reads use `.lean()`.
 */

import NetworkProfile from "../models/NetworkProfile.model.js";
import DiscoveryHistory from "../models/DiscoveryHistory.model.js";
import { ProfileNotFoundError } from "../errors.js";
import { ProfileState } from "../types/types.js";

const LIVE = [ProfileState.DISCOVERING, ProfileState.READY];

/**
 * @param {{ NetworkProfileModel?: import("mongoose").Model, DiscoveryHistoryModel?: import("mongoose").Model }} [models]
 * @returns {{ profiles: object, history: object }}
 */
export function createMongoDiscoveryRepository(models = {}) {
  const ProfileModel = models.NetworkProfileModel ?? NetworkProfile;
  const HistoryModel = models.DiscoveryHistoryModel ?? DiscoveryHistory;

  const profiles = {
    async create(profile) {
      // A device has one current profile; mark any prior live profile stale.
      await ProfileModel.updateMany({ deviceId: String(profile.deviceId), state: { $in: LIVE } }, { $set: { state: ProfileState.STALE } });
      const doc = await ProfileModel.create(profile);
      return stripMongo(doc.toObject());
    },
    async findById(profileId) {
      return stripMongo(await ProfileModel.findOne({ profileId: String(profileId) }).lean());
    },
    async findByDevice(deviceId) {
      return stripMongo(await ProfileModel.findOne({ deviceId: String(deviceId), state: { $in: LIVE } }).sort({ discoveredAt: -1 }).lean());
    },
    async update(profileId, patch) {
      const updated = await ProfileModel.findOneAndUpdate({ profileId: String(profileId) }, patch, { new: true }).lean();
      if (!updated) throw new ProfileNotFoundError("Network profile not found", { details: { profileId } });
      return stripMongo(updated);
    },
    async delete(profileId) {
      const res = await ProfileModel.deleteOne({ profileId: String(profileId) });
      return res.deletedCount > 0;
    },
    async listByUser(userId) {
      return (await ProfileModel.find({ userId: String(userId) }).lean()).map(stripMongo);
    },
    async listExpired(nowIso) {
      const now = nowIso ?? new Date().toISOString();
      return (await ProfileModel.find({ state: { $in: LIVE }, expiresAt: { $lte: now } }).lean()).map(stripMongo);
    },
  };

  const history = {
    async record(snapshot) {
      const doc = await HistoryModel.create(snapshot);
      return stripMongo(doc.toObject());
    },
    async listByDevice(deviceId, options = {}) {
      const q = HistoryModel.find({ deviceId: String(deviceId) }).sort({ at: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
  };

  return { profiles, history };
}

function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

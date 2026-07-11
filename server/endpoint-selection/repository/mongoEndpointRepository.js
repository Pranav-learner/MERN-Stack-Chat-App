/**
 * @module endpoint-selection/repository/mongo
 *
 * MongoDB (Mongoose) Endpoint Selection repositories. Mirrors the contract in
 * {@link module:endpoint-selection/repository/inMemory}. Stores PUBLIC selection metadata only — no
 * field for a private key, session key, or shared secret. Reads use `.lean()`.
 */

import EndpointConnectionPlan from "../models/EndpointConnectionPlan.model.js";
import SelectionRecord from "../models/SelectionRecord.model.js";
import EndpointReliability from "../models/EndpointReliability.model.js";
import { EndpointNotFoundError } from "../errors.js";
import { OutcomeType } from "../types/types.js";

/**
 * @param {{ EndpointConnectionPlanModel?: import("mongoose").Model, SelectionRecordModel?: import("mongoose").Model, EndpointReliabilityModel?: import("mongoose").Model }} [models]
 * @returns {{ plans: object, selections: object, reliability: object }}
 */
export function createMongoEndpointRepository(models = {}) {
  const PlanModel = models.EndpointConnectionPlanModel ?? EndpointConnectionPlan;
  const SelectionModel = models.SelectionRecordModel ?? SelectionRecord;
  const ReliabilityModel = models.EndpointReliabilityModel ?? EndpointReliability;

  const plans = {
    async create(plan) {
      const doc = await PlanModel.create(plan);
      return stripMongo(doc.toObject());
    },
    async findById(planId) {
      return stripMongo(await PlanModel.findOne({ planId: String(planId) }).lean());
    },
    async update(planId, patch) {
      const updated = await PlanModel.findOneAndUpdate({ planId: String(planId) }, patch, { new: true }).lean();
      if (!updated) throw new EndpointNotFoundError("Connection plan not found", { details: { planId } });
      return stripMongo(updated);
    },
    async delete(planId) {
      const res = await PlanModel.deleteOne({ planId: String(planId) });
      return res.deletedCount > 0;
    },
    async listByRequester(requester, options = {}) {
      const q = PlanModel.find({ requester: String(requester) }).sort({ createdAt: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
  };

  const selections = {
    async record(selection) {
      const doc = await SelectionModel.create(selection);
      return stripMongo(doc.toObject());
    },
    async findById(selectionId) {
      return stripMongo(await SelectionModel.findOne({ selectionId: String(selectionId) }).lean());
    },
    async listByRequester(requester, options = {}) {
      const q = SelectionModel.find({ requester: String(requester) }).sort({ at: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
    async listByTarget(requester, targetUser, options = {}) {
      const q = SelectionModel.find({ requester: String(requester), targetUser: String(targetUser) }).sort({ at: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
  };

  const reliability = {
    async get(targetUser, deviceId) {
      return stripMongo(await ReliabilityModel.findOne({ targetUser: String(targetUser), deviceId: String(deviceId) }).lean());
    },
    async getMany(targetUser, deviceIds) {
      const rows = await ReliabilityModel.find({ targetUser: String(targetUser), deviceId: { $in: (deviceIds ?? []).map(String) } }).lean();
      const out = {};
      for (const r of rows) out[r.deviceId] = stripMongo(r);
      return out;
    },
    async record(targetUser, deviceId, outcome) {
      const inc = outcome === OutcomeType.SUCCESS ? { successes: 1 } : { failures: 1 };
      const at = new Date().toISOString();
      // Two-step so we can recompute the smoothed reliability from the post-increment counts.
      const doc = await ReliabilityModel.findOneAndUpdate(
        { targetUser: String(targetUser), deviceId: String(deviceId) },
        { $inc: inc, $set: { lastOutcome: outcome, lastOutcomeAt: at } },
        { new: true, upsert: true },
      ).lean();
      const reliabilityScore = (doc.successes + 1) / (doc.successes + doc.failures + 2);
      const finalDoc = await ReliabilityModel.findOneAndUpdate(
        { targetUser: String(targetUser), deviceId: String(deviceId) },
        { $set: { reliability: reliabilityScore } },
        { new: true },
      ).lean();
      return stripMongo(finalDoc);
    },
  };

  return { plans, selections, reliability };
}

/** Drop Mongo bookkeeping fields so DTOs stay clean + framework-owned. */
function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, updatedAt, ...rest } = doc;
  return rest;
}

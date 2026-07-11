/**
 * @module pdp/repositories/mongo
 *
 * MongoDB (Mongoose) PDP repositories. Mirrors the contract in
 * {@link module:pdp/repositories/inMemory}. Stores PDP CONTROL-PLANE metadata only — no field for a
 * private key, session key, or shared secret. Reads use `.lean()`.
 */

import PdpSession from "../models/PdpSession.model.js";
import ConnectionPlan from "../models/ConnectionPlan.model.js";
import { PdpNotFoundError } from "../errors.js";
import { ACTIVE_PDP_STATES } from "../types/types.js";
import { pdpDedupeKey } from "../workflow/session.js";

/**
 * @param {{ PdpSessionModel?: import("mongoose").Model, ConnectionPlanModel?: import("mongoose").Model }} [models]
 * @returns {{ sessions: object, plans: object }}
 */
export function createMongoPdpRepository(models = {}) {
  const SessionModel = models.PdpSessionModel ?? PdpSession;
  const PlanModel = models.ConnectionPlanModel ?? ConnectionPlan;

  const sessions = {
    async create(session) {
      const doc = await SessionModel.create({ ...session, dedupeKey: pdpDedupeKey(session) });
      return stripMongo(doc.toObject());
    },
    async findById(discoveryId) {
      return stripMongo(await SessionModel.findOne({ discoveryId: String(discoveryId) }).lean());
    },
    async update(discoveryId, patch) {
      const updated = await SessionModel.findOneAndUpdate({ discoveryId: String(discoveryId) }, patch, { new: true }).lean();
      if (!updated) throw new PdpNotFoundError("Discovery session not found", { details: { discoveryId } });
      return stripMongo(updated);
    },
    async delete(discoveryId) {
      const res = await SessionModel.deleteOne({ discoveryId: String(discoveryId) });
      return res.deletedCount > 0;
    },
    async findActiveByDedupeKey(dedupeKey) {
      return stripMongo(await SessionModel.findOne({ dedupeKey, state: { $in: ACTIVE_PDP_STATES } }).sort({ createdAt: -1 }).lean());
    },
    async listByRequester(requester, options = {}) {
      const filter = { requester: String(requester) };
      if (options.activeOnly) filter.state = { $in: ACTIVE_PDP_STATES };
      const q = SessionModel.find(filter).sort({ createdAt: -1 });
      if (options.limit) q.limit(options.limit);
      return (await q.lean()).map(stripMongo);
    },
    async listExpired(nowIso) {
      const now = nowIso ?? new Date().toISOString();
      return (await SessionModel.find({ state: { $in: ACTIVE_PDP_STATES }, expiresAt: { $lte: now } }).lean()).map(stripMongo);
    },
  };

  const plans = {
    async create(plan) {
      const doc = await PlanModel.create(plan);
      return stripMongo(doc.toObject());
    },
    async findById(planId) {
      return stripMongo(await PlanModel.findOne({ planId: String(planId) }).lean());
    },
    async findByDiscoveryId(discoveryId) {
      return stripMongo(await PlanModel.findOne({ discoveryId: String(discoveryId) }).sort({ createdAt: -1 }).lean());
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

  return { sessions, plans };
}

/** Drop Mongo bookkeeping fields so DTOs stay clean + framework-owned. */
function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, updatedAt, ...rest } = doc;
  return rest;
}

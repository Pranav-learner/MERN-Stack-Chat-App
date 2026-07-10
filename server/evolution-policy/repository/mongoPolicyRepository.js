/**
 * @module evolution-policy/repository/mongo
 *
 * MongoDB (Mongoose) automatic-rekey repository. Mirrors the contract in
 * {@link module:evolution-policy/repository/inMemory}. Stores rekey METADATA only — the
 * schema has no field for a key or secret. Reads use `.lean()`. Keyed by `sessionId`.
 */

import RekeyPolicyState from "../models/RekeyPolicyState.model.js";
import { RekeyNotConfiguredError } from "../errors.js";

/**
 * @param {{ RekeyPolicyStateModel?: import("mongoose").Model }} [models]
 * @returns {{ rekeyPolicies: object }}
 */
export function createMongoPolicyRepository(models = {}) {
  const Model = models.RekeyPolicyStateModel ?? RekeyPolicyState;

  const rekeyPolicies = {
    async create(state) {
      const doc = await Model.create(state);
      return doc.toObject();
    },
    async findBySessionId(sessionId) {
      return Model.findOne({ sessionId: String(sessionId) }).lean();
    },
    async update(sessionId, patch) {
      const updated = await Model.findOneAndUpdate({ sessionId: String(sessionId) }, patch, { new: true }).lean();
      if (!updated) throw new RekeyNotConfiguredError("Automatic rekeying is not configured for this session", { details: { sessionId } });
      return updated;
    },
    async delete(sessionId) {
      const res = await Model.deleteOne({ sessionId: String(sessionId) });
      return res.deletedCount > 0;
    },
    async findEnabled() {
      return Model.find({ "config.enabled": { $ne: false } }).lean();
    },
    async listAll() {
      return Model.find({}).lean();
    },
  };

  return { rekeyPolicies };
}

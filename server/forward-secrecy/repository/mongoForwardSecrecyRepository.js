/**
 * @module forward-secrecy/repository/mongo
 *
 * MongoDB (Mongoose) Forward Secrecy metadata repository. Mirrors the contract in
 * {@link module:forward-secrecy/repository/inMemory}. Stores FS METADATA only — the
 * schema has no field for a chain secret, derived key, or shared secret. Reads use
 * `.lean()`. Keyed by `sessionId` (one FS record per Secure Session).
 */

import ForwardSecrecyState from "../models/ForwardSecrecyState.model.js";
import { GenerationNotFoundError } from "../errors.js";

/**
 * @param {{ ForwardSecrecyStateModel?: import("mongoose").Model }} [models]
 * @returns {{ forwardSecrecy: object }}
 */
export function createMongoForwardSecrecyRepository(models = {}) {
  const Model = models.ForwardSecrecyStateModel ?? ForwardSecrecyState;

  const forwardSecrecy = {
    async create(state) {
      const doc = await Model.create(state);
      return doc.toObject();
    },
    async findBySessionId(sessionId) {
      return Model.findOne({ sessionId: String(sessionId) }).lean();
    },
    async update(sessionId, patch) {
      const updated = await Model.findOneAndUpdate({ sessionId: String(sessionId) }, patch, { new: true }).lean();
      if (!updated) throw new GenerationNotFoundError("Forward secrecy state not found", { details: { sessionId } });
      return updated;
    },
    async delete(sessionId) {
      const res = await Model.deleteOne({ sessionId: String(sessionId) });
      return res.deletedCount > 0;
    },
    async findByGeneration(min) {
      return Model.find({ currentGeneration: { $gte: min } }).lean();
    },
    async listAll() {
      return Model.find({}).lean();
    },
  };

  return { forwardSecrecy };
}

/**
 * @module session-evolution/repository/mongo
 *
 * MongoDB (Mongoose) Evolution repository. Mirrors the contract in
 * {@link module:session-evolution/repository/inMemory}. Stores evolution METADATA only —
 * the schema has no field for a raw key, shared secret, or ratchet secret. Reads use
 * `.lean()`. The primary key is `sessionId` (one evolution record per Secure Session).
 */

import EvolutionState from "../models/EvolutionState.model.js";
import { EvolutionNotFoundError } from "../errors.js";

/**
 * @param {{ EvolutionStateModel?: import("mongoose").Model }} [models]
 * @returns {{ evolutions: object }}
 */
export function createMongoEvolutionRepository(models = {}) {
  const Model = models.EvolutionStateModel ?? EvolutionState;

  const evolutions = {
    async create(record) {
      const doc = await Model.create(record);
      return doc.toObject();
    },
    async findBySessionId(sessionId) {
      return Model.findOne({ sessionId: String(sessionId) }).lean();
    },
    async findById(evolutionId) {
      return Model.findOne({ evolutionId }).lean();
    },
    async update(sessionId, patch) {
      const updated = await Model.findOneAndUpdate({ sessionId: String(sessionId) }, patch, { new: true }).lean();
      if (!updated) throw new EvolutionNotFoundError("Evolution state not found", { details: { sessionId } });
      return updated;
    },
    async delete(sessionId) {
      const res = await Model.deleteOne({ sessionId: String(sessionId) });
      return res.deletedCount > 0;
    },
    async findByState(state) {
      return Model.find({ state }).lean();
    },
    async listAll() {
      return Model.find({}).lean();
    },
  };

  return { evolutions };
}

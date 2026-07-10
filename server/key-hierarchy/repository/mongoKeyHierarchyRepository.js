/**
 * @module key-hierarchy/repository/mongo
 *
 * MongoDB (Mongoose) key-hierarchy repository. Mirrors the contract in
 * {@link module:key-hierarchy/repository/inMemory}. Stores hierarchy METADATA only — the
 * schema has no field for a root/chain key or shared secret. Reads use `.lean()`. Keyed by
 * `sessionId`.
 */

import KeyHierarchyState from "../models/KeyHierarchyState.model.js";
import { HierarchyNotFoundError } from "../errors.js";

/**
 * @param {{ KeyHierarchyStateModel?: import("mongoose").Model }} [models]
 * @returns {{ hierarchies: object }}
 */
export function createMongoKeyHierarchyRepository(models = {}) {
  const Model = models.KeyHierarchyStateModel ?? KeyHierarchyState;

  const hierarchies = {
    async create(state) {
      const doc = await Model.create(state);
      return doc.toObject();
    },
    async findBySessionId(sessionId) {
      return Model.findOne({ sessionId: String(sessionId) }).lean();
    },
    async update(sessionId, patch) {
      const updated = await Model.findOneAndUpdate({ sessionId: String(sessionId) }, patch, { new: true }).lean();
      if (!updated) throw new HierarchyNotFoundError("Key hierarchy not found", { details: { sessionId } });
      return updated;
    },
    async delete(sessionId) {
      const res = await Model.deleteOne({ sessionId: String(sessionId) });
      return res.deletedCount > 0;
    },
    async findByGeneration(min) {
      return Model.find({ generation: { $gte: min } }).lean();
    },
    async listAll() {
      return Model.find({}).lean();
    },
  };

  return { hierarchies };
}

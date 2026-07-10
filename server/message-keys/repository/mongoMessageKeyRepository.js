/**
 * @module message-keys/repository/mongo
 *
 * MongoDB (Mongoose) message-key repository. Mirrors the contract in
 * {@link module:message-keys/repository/inMemory}. Stores message METADATA only — the schema
 * has no field for a message/chain key. Reads use `.lean()`. Keyed by `sessionId`.
 */

import MessageKeyState from "../models/MessageKeyState.model.js";
import { MessageKeyNotFoundError } from "../errors.js";

/**
 * @param {{ MessageKeyStateModel?: import("mongoose").Model }} [models]
 * @returns {{ messageKeys: object }}
 */
export function createMongoMessageKeyRepository(models = {}) {
  const Model = models.MessageKeyStateModel ?? MessageKeyState;

  const messageKeys = {
    async create(state) {
      const doc = await Model.create(state);
      return doc.toObject();
    },
    async findBySessionId(sessionId) {
      return Model.findOne({ sessionId: String(sessionId) }).lean();
    },
    async update(sessionId, patch) {
      const updated = await Model.findOneAndUpdate({ sessionId: String(sessionId) }, patch, { new: true }).lean();
      if (!updated) throw new MessageKeyNotFoundError("Message key state not found", { details: { sessionId } });
      return updated;
    },
    async delete(sessionId) {
      const res = await Model.deleteOne({ sessionId: String(sessionId) });
      return res.deletedCount > 0;
    },
    async listAll() {
      return Model.find({}).lean();
    },
  };

  return { messageKeys };
}

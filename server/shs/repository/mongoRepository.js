/**
 * @module shs/repository/mongo
 *
 * MongoDB (Mongoose) handshake-session repository. Mirrors the contract in
 * {@link module:shs/repository/inMemory}. Reads use `.lean()`. The active-pair query
 * excludes terminal states so a fresh handshake is only blocked by a live one.
 */

import HandshakeSession from "../models/HandshakeSession.model.js";
import { TERMINAL_HANDSHAKE_STATES } from "../types.js";
import { HandshakeNotFoundError } from "../errors.js";

/**
 * @param {{ HandshakeSessionModel?: import("mongoose").Model }} [models]
 * @returns {{ sessions: object }}
 */
export function createMongoShsRepository(models = {}) {
  const Model = models.HandshakeSessionModel ?? HandshakeSession;

  const sessions = {
    async create(session) {
      const doc = await Model.create(session);
      return doc.toObject();
    },
    async findById(handshakeId) {
      return Model.findOne({ handshakeId }).lean();
    },
    async update(handshakeId, patch) {
      const updated = await Model.findOneAndUpdate({ handshakeId }, patch, { new: true }).lean();
      if (!updated) throw new HandshakeNotFoundError("Handshake not found", { details: { handshakeId } });
      return updated;
    },
    async delete(handshakeId) {
      const res = await Model.deleteOne({ handshakeId });
      return res.deletedCount > 0;
    },
    async findActiveByPair(initiator, responder) {
      return Model.findOne({
        initiator,
        responder,
        state: { $nin: TERMINAL_HANDSHAKE_STATES },
      })
        .sort({ createdAt: -1 })
        .lean();
    },
    async listByUser(userId) {
      return Model.find({ $or: [{ initiator: userId }, { responder: userId }] })
        .sort({ createdAt: -1 })
        .lean();
    },
    async findByState(state) {
      return Model.find({ state }).lean();
    },
    async listAll() {
      return Model.find({}).lean();
    },
  };

  return { sessions };
}

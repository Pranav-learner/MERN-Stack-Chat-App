/**
 * @module shs/key-agreement/repository/mongo
 *
 * MongoDB (Mongoose) key-agreement repository. Provides the `exchanges` store ONLY —
 * the PUBLIC coordination records. It deliberately does NOT implement a `material`
 * store: **the server never persists shared secrets or private keys.** Session
 * material (with the secret) lives exclusively in device-local storage (the client /
 * in-memory repository).
 *
 * Mirrors the `exchanges` contract in {@link module:shs/key-agreement/repository/inMemory}.
 * Reads use `.lean()`.
 */

import KeyExchange from "../models/KeyExchange.model.js";
import { ExchangeNotFoundError } from "../errors.js";
import { TERMINAL_EXCHANGE_STATES } from "./constants.js";

/**
 * @param {{ KeyExchangeModel?: import("mongoose").Model }} [models]
 * @returns {{ exchanges: object }}
 */
export function createMongoKeyAgreementRepositories(models = {}) {
  const Model = models.KeyExchangeModel ?? KeyExchange;

  const exchanges = {
    async create(record) {
      const doc = await Model.create(record);
      return doc.toObject();
    },
    async findById(handshakeId) {
      return Model.findOne({ handshakeId }).lean();
    },
    async update(handshakeId, patch) {
      const updated = await Model.findOneAndUpdate({ handshakeId }, patch, { new: true }).lean();
      if (!updated) throw new ExchangeNotFoundError("Exchange not found", { details: { handshakeId } });
      return updated;
    },
    async delete(handshakeId) {
      const res = await Model.deleteOne({ handshakeId });
      return res.deletedCount > 0;
    },
    async findActive(handshakeId) {
      return Model.findOne({
        handshakeId,
        state: { $nin: [...TERMINAL_EXCHANGE_STATES] },
      }).lean();
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

  return { exchanges };
}

/**
 * @module shs/session/repository/mongo
 *
 * MongoDB (Mongoose) Secure Session repository. Mirrors the contract in
 * {@link module:shs/session/repository/inMemory}. Stores session METADATA only — the
 * schema has no field for raw keys or secrets. Reads use `.lean()`.
 */

import SecureSession from "../models/SecureSession.model.js";
import { SessionNotFoundError } from "../errors.js";

const ACTIVE_STATES = ["created", "active", "idle", "paused", "resumed"];

/**
 * @param {{ SecureSessionModel?: import("mongoose").Model }} [models]
 * @returns {{ sessions: object }}
 */
export function createMongoSessionRepository(models = {}) {
  const Model = models.SecureSessionModel ?? SecureSession;

  const sessions = {
    async create(session) {
      const doc = await Model.create(session);
      return doc.toObject();
    },
    async findById(sessionId) {
      return Model.findOne({ sessionId }).lean();
    },
    async update(sessionId, patch) {
      const updated = await Model.findOneAndUpdate({ sessionId }, patch, { new: true }).lean();
      if (!updated) throw new SessionNotFoundError("Session not found", { details: { sessionId } });
      return updated;
    },
    async delete(sessionId) {
      const res = await Model.deleteOne({ sessionId });
      return res.deletedCount > 0;
    },
    async findActiveByHandshake(handshakeId) {
      return Model.findOne({ handshakeId, status: { $in: ACTIVE_STATES } })
        .sort({ createdAt: -1 })
        .lean();
    },
    async listByUser(userId) {
      return Model.find({ participants: userId }).sort({ createdAt: -1 }).lean();
    },
    async findByState(state) {
      return Model.find({ status: state }).lean();
    },
    async listAll() {
      return Model.find({}).lean();
    },
  };

  return { sessions };
}

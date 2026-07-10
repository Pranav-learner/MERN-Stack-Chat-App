/**
 * @module crypto-hardening/repository/mongo
 *
 * MongoDB (Mongoose) hardening repository. Mirrors the contract in
 * {@link module:crypto-hardening/repository/inMemory}. Stores security-alert METADATA only.
 * Reads use `.lean()`.
 */

import SecurityAlert from "../models/SecurityAlert.model.js";

/**
 * @param {{ SecurityAlertModel?: import("mongoose").Model }} [models]
 * @returns {{ alerts: object }}
 */
export function createMongoHardeningRepository(models = {}) {
  const Model = models.SecurityAlertModel ?? SecurityAlert;

  const alerts = {
    async record(alert) {
      const doc = await Model.create(alert);
      return doc.toObject();
    },
    async list({ limit = 100 } = {}) {
      return Model.find({}).sort({ createdAt: -1 }).limit(limit).lean();
    },
    async listBySession(sessionId, { limit = 100 } = {}) {
      return Model.find({ sessionId: String(sessionId) }).sort({ createdAt: -1 }).limit(limit).lean();
    },
    async count() {
      return Model.countDocuments({});
    },
  };

  return { alerts };
}

/**
 * @module networking-hardening/repository/mongo
 *
 * MongoDB (Mongoose) hardening repository. Mirrors the in-memory alert-store contract. Persists
 * networking alerts; stores PUBLIC alert metadata only. Reads use `.lean()`.
 */

import NetworkAlert from "../models/NetworkAlert.model.js";

/**
 * @param {{ NetworkAlertModel?: import("mongoose").Model }} [models]
 * @returns {{ alerts: object }}
 */
export function createMongoHardeningRepository(models = {}) {
  const Model = models.NetworkAlertModel ?? NetworkAlert;

  const alerts = {
    async record(alert) {
      const doc = await Model.create(alert);
      return stripMongo(doc.toObject());
    },
    async list(options = {}) {
      const filter = {};
      if (options.alertType) filter.alertType = options.alertType;
      if (options.severity) filter.severity = options.severity;
      const q = Model.find(filter).sort({ at: -1 });
      if (options.offset) q.skip(options.offset);
      q.limit(options.limit ?? 50);
      return (await q.lean()).map(stripMongo);
    },
    async count(options = {}) {
      const filter = {};
      if (options.alertType) filter.alertType = options.alertType;
      return Model.countDocuments(filter);
    },
  };

  return { alerts };
}

function stripMongo(doc) {
  if (!doc) return doc;
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

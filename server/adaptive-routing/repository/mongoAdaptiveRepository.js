/**
 * @module adaptive-routing/repository/mongo
 *
 * Mongo-backed adaptive repositories — the production backend for the same store contracts the in-memory
 * repository implements (STEP 10). Persists negotiated capability profiles, route evaluations (the bundled
 * analysis + ranked scores + selection + execution/fallback plans + policy refs), and the audit trail to
 * three collections. Storage-independent: the engine only knows the contract, so swapping backends is a
 * one-line change.
 *
 * @security Only control-plane fields are persisted; the engine's no-content scan runs before any write.
 */

import CapabilityProfileModel from "../models/CapabilityProfile.model.js";
import RouteEvaluationModel from "../models/RouteEvaluation.model.js";
import AdaptiveAuditLogModel from "../models/AdaptiveAuditLog.model.js";

const lean = (doc) => (doc ? JSON.parse(JSON.stringify(doc)) : null);

export function createMongoAdaptiveRepository() {
  const capabilities = {
    async upsert(profile) {
      const doc = await CapabilityProfileModel.findOneAndUpdate({ fingerprint: profile.fingerprint }, { $set: profile }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
      return lean(doc);
    },
    async findByFingerprint(fingerprint) {
      return lean(await CapabilityProfileModel.findOne({ fingerprint }).lean());
    },
  };

  const evaluations = {
    async create(record) {
      return lean(await RouteEvaluationModel.create(record));
    },
    async findByRequest(requestId) {
      return lean(await RouteEvaluationModel.findOne({ requestId }).sort({ createdAt: -1 }).lean());
    },
    async listRecent({ limit = 100 } = {}) {
      return (await RouteEvaluationModel.find({}).sort({ createdAt: -1 }).limit(limit).lean()).map(lean);
    },
  };

  const audit = {
    async append(entry) {
      return lean(await AdaptiveAuditLogModel.create(entry));
    },
    async listByRequest(requestId, { limit = 200 } = {}) {
      return (await AdaptiveAuditLogModel.find({ requestId }).sort({ createdAt: 1 }).limit(limit).lean()).map(lean);
    },
  };

  return { capabilities, evaluations, audit };
}

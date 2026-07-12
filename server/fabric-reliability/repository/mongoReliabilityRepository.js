/**
 * @module fabric-reliability/repository/mongo
 *
 * Mongo-backed reliability repositories — the production backend for the same store contracts the
 * in-memory repository implements (STEP 9). Persists operation checkpoints, health snapshots, and the
 * audit trail to three collections. Storage-independent: the reliability layer only knows the contract, so
 * swapping backends (or a future distributed store) is a one-line change.
 *
 * @security Only control-plane fields are persisted; the layer's no-content scan runs before any write.
 */

import FabricOperationModel from "../models/FabricOperation.model.js";
import FabricHealthSnapshotModel from "../models/FabricHealthSnapshot.model.js";
import FabricReliabilityAuditLogModel from "../models/FabricReliabilityAuditLog.model.js";

const lean = (doc) => (doc ? JSON.parse(JSON.stringify(doc)) : null);
const TERMINAL = ["succeeded", "recovered", "gracefully-failed", "aborted"];

export function createMongoReliabilityRepository() {
  const operations = {
    async upsert(checkpoint) {
      const doc = await FabricOperationModel.findOneAndUpdate({ operationId: checkpoint.operationId }, { $set: checkpoint }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
      return lean(doc);
    },
    async findById(operationId) {
      return lean(await FabricOperationModel.findOne({ operationId }).lean());
    },
    async listActive() {
      return (await FabricOperationModel.find({ state: { $nin: TERMINAL } }).limit(1000).lean()).map(lean);
    },
    async delete(operationId) {
      const r = await FabricOperationModel.deleteOne({ operationId });
      return r.deletedCount > 0;
    },
    async cleanup(olderThanMs, now = Date.now()) {
      const cutoff = new Date(now - olderThanMs).toISOString();
      const r = await FabricOperationModel.deleteMany({ state: { $in: TERMINAL }, updatedAt: { $lt: cutoff } });
      return r.deletedCount ?? 0;
    },
  };

  const health = {
    async recordSnapshot(snapshot) {
      return lean(await FabricHealthSnapshotModel.create(snapshot));
    },
    async latest() {
      return lean(await FabricHealthSnapshotModel.findOne({}).sort({ createdAt: -1 }).lean());
    },
    async list({ limit = 100 } = {}) {
      return (await FabricHealthSnapshotModel.find({}).sort({ createdAt: -1 }).limit(limit).lean()).map(lean);
    },
  };

  const audit = {
    async append(entry) {
      return lean(await FabricReliabilityAuditLogModel.create(entry));
    },
    async listByOperation(operationId, { limit = 200 } = {}) {
      return (await FabricReliabilityAuditLogModel.find({ operationId }).sort({ createdAt: 1 }).limit(limit).lean()).map(lean);
    },
    async listRecent({ limit = 100 } = {}) {
      return (await FabricReliabilityAuditLogModel.find({}).sort({ createdAt: -1 }).limit(limit).lean()).map(lean);
    },
  };

  return { operations, health, audit };
}

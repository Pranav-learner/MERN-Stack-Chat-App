/**
 * @module optimization/repository/mongo
 *
 * Mongo-backed optimization repositories — the production backend for the same store contracts the
 * in-memory repository implements (STEP 10). Persists resource snapshots, optimization records (the
 * bundled QoS + scheduling + allocation + coordination + balance + optimized plan), and the audit trail
 * to three collections. Storage-independent: the optimizer only knows the contract.
 *
 * @security Only control-plane fields are persisted; the optimizer's no-content scan runs before any write.
 */

import ResourceSnapshotModel from "../models/ResourceSnapshot.model.js";
import OptimizationRecordModel from "../models/OptimizationRecord.model.js";
import OptimizationAuditLogModel from "../models/OptimizationAuditLog.model.js";

const lean = (doc) => (doc ? JSON.parse(JSON.stringify(doc)) : null);

export function createMongoOptimizationRepository() {
  const resources = {
    async recordSnapshot(snapshot) {
      return lean(await ResourceSnapshotModel.create(snapshot));
    },
    async latest() {
      return lean(await ResourceSnapshotModel.findOne({}).sort({ createdAt: -1 }).lean());
    },
    async list({ limit = 100 } = {}) {
      return (await ResourceSnapshotModel.find({}).sort({ createdAt: -1 }).limit(limit).lean()).map(lean);
    },
  };

  const optimizations = {
    async create(record) {
      return lean(await OptimizationRecordModel.create(record));
    },
    async findByRequest(requestId) {
      return lean(await OptimizationRecordModel.findOne({ requestId }).sort({ createdAt: -1 }).lean());
    },
    async listRecent({ limit = 100 } = {}) {
      return (await OptimizationRecordModel.find({}).sort({ createdAt: -1 }).limit(limit).lean()).map(lean);
    },
  };

  const audit = {
    async append(entry) {
      return lean(await OptimizationAuditLogModel.create(entry));
    },
    async listByRequest(requestId, { limit = 200 } = {}) {
      return (await OptimizationAuditLogModel.find({ requestId }).sort({ createdAt: 1 }).limit(limit).lean()).map(lean);
    },
  };

  return { resources, optimizations, audit };
}

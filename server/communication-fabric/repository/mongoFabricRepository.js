/**
 * @module communication-fabric/repository/mongo
 *
 * Mongo-backed Fabric repositories — the production backend for the same store contracts the in-memory
 * repository implements (STEP 10). Persists decisions, execution plans + results, and the audit trail to
 * three collections (`FabricDecision`, `FabricExecutionPlan`, `FabricAuditLog`). Storage-independent: the
 * manager only knows the store contract, so swapping this for the in-memory (or a future Redis) backend
 * is a one-line change.
 *
 * @security Only control-plane fields are persisted; the manager's no-content scan runs before any write.
 */

import FabricDecisionModel from "../models/FabricDecision.model.js";
import FabricExecutionPlanModel from "../models/FabricExecutionPlan.model.js";
import FabricAuditLogModel from "../models/FabricAuditLog.model.js";

const lean = (doc) => (doc ? JSON.parse(JSON.stringify(doc)) : null);

export function createMongoFabricRepository() {
  const decisions = {
    async create(decision) {
      const doc = await FabricDecisionModel.findOneAndUpdate({ decisionId: decision.decisionId }, { $setOnInsert: decision }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
      return lean(doc);
    },
    async findById(decisionId) {
      return lean(await FabricDecisionModel.findOne({ decisionId }).lean());
    },
    async listByRequest(requestId, { limit = 100 } = {}) {
      return (await FabricDecisionModel.find({ requestId }).sort({ createdAt: 1 }).limit(limit).lean()).map(lean);
    },
  };

  const plans = {
    async create(plan) {
      const record = {
        planId: plan.planId,
        requestId: plan.requestId,
        decisionId: plan.decisionId,
        strategyType: plan.strategyType,
        steps: plan.steps,
        routing: plan.routing,
        status: "planned",
        schemaVersion: plan.schemaVersion,
        createdAt: plan.createdAt,
      };
      const doc = await FabricExecutionPlanModel.findOneAndUpdate({ planId: plan.planId }, { $setOnInsert: record }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
      return lean(doc);
    },
    async findById(planId) {
      return lean(await FabricExecutionPlanModel.findOne({ planId }).lean());
    },
    async update(planId, patch) {
      return lean(await FabricExecutionPlanModel.findOneAndUpdate({ planId }, { $set: patch }, { new: true }).lean());
    },
  };

  const executions = {
    // The execution result is folded onto the plan document (status + step ledger + timing).
    async create(snapshot) {
      const patch = {
        status: snapshot.status,
        steps: snapshot.steps,
        durationMs: snapshot.durationMs,
        startedAt: snapshot.startedAt,
        finishedAt: snapshot.finishedAt,
      };
      const doc = await FabricExecutionPlanModel.findOneAndUpdate({ planId: snapshot.planId }, { $set: patch }, { new: true, upsert: true, setDefaultsOnInsert: true }).lean();
      return lean(doc);
    },
    async findById(planId) {
      return lean(await FabricExecutionPlanModel.findOne({ planId }).lean());
    },
    async listRecent({ limit = 100 } = {}) {
      return (await FabricExecutionPlanModel.find({ status: { $ne: "planned" } }).sort({ updatedAt: -1 }).limit(limit).lean()).map(lean);
    },
  };

  const audit = {
    async append(entry) {
      return lean(await FabricAuditLogModel.create(entry));
    },
    async listByRequest(requestId, { limit = 200 } = {}) {
      return (await FabricAuditLogModel.find({ requestId }).sort({ createdAt: 1 }).limit(limit).lean()).map(lean);
    },
  };

  return { decisions, plans, executions, audit };
}

/**
 * @module optimization/planners/executionPlanner
 *
 * The **Optimized Execution Planner** (STEP 9) — assembles the single unified plan the optimizer produces
 * from all the upstream stage outputs: the frozen Sprint-1 execution plan, the scheduling decision, the
 * QoS plan, the resource allocation plan, the cross-device coordination plan, the fallback plan, and the
 * execution timeline. It VALIDATES the assembled plan for consistency (STEP 14): the scheduling status
 * must agree with the `proceed` flag, an immediate plan must have a timeline, and the referenced execution
 * plan must be non-empty.
 *
 * @security The optimized plan bundles control-plane sub-plans (ids + classifications + budgets + offsets)
 * only. No content.
 */

import { deepFreeze, assertNoContent } from "../_fabric.js";
import { buildTimeline } from "./executionTimeline.js";
import { InvalidOptimizedPlanError } from "../errors.js";
import { ScheduleStatus, SchedulingMode, OPTIMIZATION_SCHEMA_VERSION } from "../types/types.js";

let PLAN_SEQ = 0;

export class OptimizedExecutionPlanner {
  /** @param {object} [deps] @param {() => number} [deps.clock] @param {() => string} [deps.idGenerator] */
  constructor(deps = {}) {
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => `oplan_${(PLAN_SEQ = (PLAN_SEQ + 1) % Number.MAX_SAFE_INTEGER)}`);
  }

  /**
   * Assemble + validate the optimized execution plan.
   * @param {object} parts `{ requestId, executionPlan, qos, scheduling, allocation, coordination, fallbackPlan, cost }`
   * @returns {import("../types/types.js").OptimizedExecutionPlan}
   */
  build(parts) {
    const { requestId, executionPlan, qos, scheduling, allocation, coordination, fallbackPlan, cost } = parts;
    if (!executionPlan || !Array.isArray(executionPlan.steps) || executionPlan.steps.length === 0) {
      throw new InvalidOptimizedPlanError("Optimized plan requires a non-empty execution plan", { details: { requestId } });
    }
    if (!scheduling || !scheduling.status) throw new InvalidOptimizedPlanError("Optimized plan requires a scheduling decision", { details: { requestId } });

    // consistency: proceed ⇔ IMMEDIATE status; a deferred/queued plan must name a lane
    const proceed = scheduling.status === ScheduleStatus.IMMEDIATE;
    if (proceed !== !!scheduling.proceed) throw new InvalidOptimizedPlanError("Scheduling status disagrees with proceed flag", { details: { status: scheduling.status, proceed: scheduling.proceed } });
    if (!proceed && scheduling.status !== ScheduleStatus.REJECTED && !scheduling.lane) throw new InvalidOptimizedPlanError("A queued/deferred plan must name a lane", { details: { status: scheduling.status } });

    const baseOffsetMs = scheduling.window?.notBefore != null ? Math.max(0, scheduling.window.notBefore - this.clock()) : 0;
    const timeline = buildTimeline(executionPlan, { baseOffsetMs });

    const plan = deepFreeze({
      planId: this.idGenerator(),
      requestId,
      executionPlanId: executionPlan.planId ?? null,
      strategyType: executionPlan.strategyType ?? null,
      // sub-plans
      schedulingPlan: { mode: scheduling.mode, status: scheduling.status, lane: scheduling.lane, window: scheduling.window ?? null, position: scheduling.position ?? -1, proceed },
      qosPlan: { qosClass: qos.qosClass, lane: qos.lane, weight: qos.weight, policyRefs: qos.policyRefs ?? [] },
      resourceAllocationPlan: allocation ?? { reserved: null },
      coordinationPlan: coordination ? { primary: coordination.primary, replicas: coordination.replicas, plan: coordination.plan } : null,
      fallbackPlan: fallbackPlan ?? null,
      timeline: timeline.steps,
      estimatedTotalMs: timeline.estimatedTotalMs,
      cost: cost ?? null,
      metadata: { mode: scheduling.mode, batched: scheduling.mode === SchedulingMode.BATCH, deferred: !proceed, deviceCount: coordination?.deviceCount ?? 0 },
      schemaVersion: OPTIMIZATION_SCHEMA_VERSION,
      createdAt: new Date(this.clock()).toISOString(),
    });

    assertNoContent(plan);
    return plan;
  }
}

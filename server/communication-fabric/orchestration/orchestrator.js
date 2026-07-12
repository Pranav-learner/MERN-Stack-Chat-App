/**
 * @module communication-fabric/orchestration/orchestrator
 *
 * The **Orchestrator** (STEP 3 "Coordinate Subsystems" + "Handle Failures") — executes an
 * {@link ExecutionPlan} by walking its steps in dependency order, delegating each to its subsystem via the
 * {@link SubsystemCoordinator}, driving an {@link ExecutionTracker}, and applying the static fallback
 * framework when a step fails. It embeds NO lower-layer business logic — every actual action happens in a
 * registered adapter. Its whole job is order + delegation + failure handling.
 *
 * Failure semantics:
 *   - A step whose dependencies did not succeed is SKIPPED (optional) or FAILED (required).
 *   - A failed step first tries its ordered fallback steps (alternative routes); the first that succeeds
 *     marks the step `fell-back`.
 *   - An optional step that ultimately fails does not fail the execution; a required one does.
 *   - The final {@link ExecutionStatus} is derived from the step ledger (completed / partial / failed).
 *
 * @security The orchestrator moves control-plane steps + a control-plane context between adapters only.
 */

import { SubsystemCoordinator } from "../coordinators/subsystemCoordinator.js";
import { ExecutionTracker } from "./executionTracker.js";
import { StepStatus, FabricEventType } from "../types/types.js";

export class Orchestrator {
  /**
   * @param {object} deps
   * @param {import("../registry/subsystemRegistry.js").SubsystemRegistry} deps.registry
   * @param {import("../events/events.js").FabricEventBus} [deps.events]
   * @param {() => number} [deps.clock]
   */
  constructor(deps = {}) {
    if (!deps.registry) throw new Error("Orchestrator requires a registry");
    this.coordinator = deps.coordinator ?? new SubsystemCoordinator({ registry: deps.registry });
    this.events = deps.events ?? null;
    this.clock = deps.clock ?? (() => Date.now());
  }

  /**
   * Execute a plan.
   * @param {import("../types/types.js").ExecutionPlan} plan
   * @param {import("../contexts/communicationContext.js").CommunicationContext} context
   * @returns {Promise<object>} the execution snapshot
   */
  async execute(plan, context) {
    const tracker = new ExecutionTracker({ requestId: plan.requestId, planId: plan.planId, decisionId: plan.decisionId, strategyType: plan.strategyType, steps: plan.steps, clock: this.clock });
    tracker.start();
    this.events?.emit(FabricEventType.EXECUTION_STARTED, { requestId: plan.requestId, planId: plan.planId });

    /** stepId → terminal StepStatus, so dependents can gate on it. */
    const outcomes = new Map();

    for (const step of plan.steps) {
      // 1) dependency gate
      const unmet = (step.dependsOn ?? []).filter((dep) => !isSuccess(outcomes.get(dep)));
      if (unmet.length > 0) {
        if (step.required) {
          tracker.stepFailed(step.stepId, { code: "ERR_FABRIC_DEP", reason: "dependency-failed", note: `unmet dependencies: ${unmet.join(", ")}`, details: { unmet } });
          outcomes.set(step.stepId, StepStatus.FAILED);
          this.events?.emit(FabricEventType.STEP_FAILED, { requestId: plan.requestId, stepId: step.stepId, reason: "dependency-failed" });
        } else {
          tracker.stepSkipped(step.stepId, "dependency-failed");
          outcomes.set(step.stepId, StepStatus.SKIPPED);
        }
        continue;
      }

      // 2) run the step
      tracker.stepRunning(step.stepId);
      this.events?.emit(FabricEventType.STEP_STARTED, { requestId: plan.requestId, stepId: step.stepId, subsystem: step.subsystem, action: step.action });
      const result = await this.coordinator.run(step, context);

      if (result.ok) {
        tracker.stepSucceeded(step.stepId);
        outcomes.set(step.stepId, StepStatus.SUCCEEDED);
        this.events?.emit(FabricEventType.STEP_COMPLETED, { requestId: plan.requestId, stepId: step.stepId, subsystem: step.subsystem });
        continue;
      }

      // 3) failure → try the static fallback chain for this step
      const recovered = await this._tryFallbacks(plan, step, context, tracker);
      if (recovered) {
        tracker.stepSucceeded(step.stepId, { viaFallback: recovered.route });
        outcomes.set(step.stepId, StepStatus.FELL_BACK);
        this.events?.emit(FabricEventType.STEP_COMPLETED, { requestId: plan.requestId, stepId: step.stepId, viaFallback: recovered.route });
      } else {
        tracker.stepFailed(step.stepId, result.error);
        outcomes.set(step.stepId, StepStatus.FAILED);
        this.events?.emit(FabricEventType.STEP_FAILED, { requestId: plan.requestId, stepId: step.stepId, code: result.error?.code });
      }
    }

    const status = tracker.finish();
    const snapshot = tracker.snapshot();
    if (status === "failed") this.events?.emit(FabricEventType.EXECUTION_FAILED, { requestId: plan.requestId, planId: plan.planId, status });
    else this.events?.emit(FabricEventType.EXECUTION_COMPLETED, { requestId: plan.requestId, planId: plan.planId, status });
    return snapshot;
  }

  /** Walk a step's ordered fallback steps; return the first that succeeds, else null. */
  async _tryFallbacks(plan, step, context, tracker) {
    const chain = plan.fallbacks?.[step.stepId] ?? [];
    for (const fb of chain) {
      const result = await this.coordinator.run(fb, context);
      tracker._log("fallback-attempt", { stepId: step.stepId, route: fb.route, ok: result.ok });
      if (result.ok) return { route: fb.route };
    }
    return null;
  }
}

function isSuccess(status) {
  return status === StepStatus.SUCCEEDED || status === StepStatus.FELL_BACK;
}

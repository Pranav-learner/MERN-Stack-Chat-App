/**
 * @module communication-fabric/planners/executionPlanner
 *
 * The **Execution Planner** — assembles the final, delegatable {@link ExecutionPlan} from three inputs:
 * the winning strategy's `plan()` steps, the route metadata from the {@link RoutePlanner}, and the static
 * fallback framework. The plan is the single artifact the orchestrator executes: an ordered list of steps
 * (each naming a subsystem + action + route + dependency edges), a fallback map keyed by the step a
 * fallback recovers, and the routing metadata + diagnostics.
 *
 * The planner also VALIDATES plan consistency as it builds (STEP 14): every `dependsOn` must reference a
 * real earlier step, at least one step must be `required`, and every step must name a known subsystem.
 * This catches a broken strategy before orchestration ever runs.
 *
 * @security The plan is control-plane only. Step params carry ids + opaque refs — the no-content scan in
 * the validators runs before any persist.
 */

import { InvalidPlanError } from "../errors.js";
import { ALL_SUBSYSTEM_KINDS, FABRIC_SCHEMA_VERSION, FabricEventType } from "../types/types.js";
import { fallbacksFor } from "../routing/route.js";
import { deepFreeze } from "../contexts/communicationContext.js";

const SUBSYSTEM_SET = new Set(ALL_SUBSYSTEM_KINDS);

export class ExecutionPlanner {
  /**
   * @param {object} deps
   * @param {import("../strategies/strategy.js").StrategyRegistry} deps.strategyRegistry
   * @param {import("../routing/routePlanner.js").RoutePlanner} deps.routePlanner
   * @param {import("../events/events.js").FabricEventBus} [deps.events]
   * @param {() => string} [deps.idGenerator]
   * @param {() => number} [deps.clock]
   */
  constructor(deps = {}) {
    if (!deps.strategyRegistry) throw new Error("ExecutionPlanner requires a strategyRegistry");
    if (!deps.routePlanner) throw new Error("ExecutionPlanner requires a routePlanner");
    this.strategyRegistry = deps.strategyRegistry;
    this.routePlanner = deps.routePlanner;
    this.events = deps.events ?? null;
    this.idGenerator = deps.idGenerator ?? (() => `plan_${planSeq()}`);
    this.clock = deps.clock ?? (() => Date.now());
  }

  /**
   * Build the execution plan.
   * @param {import("../types/types.js").CommunicationDecision} decision
   * @param {import("../contexts/communicationContext.js").CommunicationContext} context
   * @returns {import("../types/types.js").ExecutionPlan}
   */
  plan(decision, context) {
    const strategy = this.strategyRegistry.get(decision.strategyType);
    const steps = strategy.plan(context, decision, { constraints: decision.constraints }) ?? [];
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new InvalidPlanError(`Strategy "${decision.strategyType}" produced no steps`, { details: { strategy: decision.strategyType } });
    }

    this._validateSteps(steps, decision);

    const route = this.routePlanner.planRoute(decision, context);

    // Attach a static fallback plan per step, keyed by stepId. A step's fallbacks are the route's fallback
    // chain re-homed onto the same action + params (deterministic; the orchestrator walks them on failure).
    const fallbacks = {};
    for (const step of steps) {
      const chain = fallbacksFor(step.route);
      if (chain.length === 0) continue;
      fallbacks[step.stepId] = chain.map((routeKind) => ({
        stepId: `${step.stepId}~fb~${routeKind}`,
        subsystem: step.subsystem,
        action: step.action,
        route: routeKind,
        required: step.required,
        dependsOn: step.dependsOn,
        params: { ...step.params, viaFallback: routeKind },
      }));
    }

    const planObj = deepFreeze({
      planId: this.idGenerator(),
      requestId: decision.requestId,
      decisionId: decision.decisionId,
      strategyType: decision.strategyType,
      steps,
      fallbacks,
      routing: route,
      requiredStepIds: steps.filter((s) => s.required).map((s) => s.stepId),
      createdAt: new Date(this.clock()).toISOString(),
      schemaVersion: FABRIC_SCHEMA_VERSION,
      version: 1,
    });

    this.events?.emit(FabricEventType.EXECUTION_PLANNED, { requestId: decision.requestId, planId: planObj.planId, stepCount: steps.length, primaryRoute: route.primary });
    return planObj;
  }

  /** Validate step consistency: known subsystems, resolvable dependencies, at least one required step. */
  _validateSteps(steps, decision) {
    const ids = new Set();
    let requiredCount = 0;
    for (const step of steps) {
      if (!step.stepId || ids.has(step.stepId)) throw new InvalidPlanError("Duplicate or missing stepId", { details: { stepId: step.stepId, strategy: decision.strategyType } });
      if (!SUBSYSTEM_SET.has(step.subsystem)) throw new InvalidPlanError(`Step names unknown subsystem "${step.subsystem}"`, { details: { stepId: step.stepId } });
      for (const dep of step.dependsOn ?? []) {
        if (!ids.has(dep)) throw new InvalidPlanError(`Step "${step.stepId}" depends on "${dep}" which is not an earlier step`, { details: { stepId: step.stepId, dep } });
      }
      ids.add(step.stepId);
      if (step.required) requiredCount++;
    }
    if (requiredCount === 0) throw new InvalidPlanError("Execution plan has no required step", { details: { strategy: decision.strategyType } });
  }
}

let _planSeq = 0;
function planSeq() {
  _planSeq = (_planSeq + 1) % Number.MAX_SAFE_INTEGER;
  return _planSeq;
}

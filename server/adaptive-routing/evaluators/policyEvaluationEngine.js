/**
 * @module adaptive-routing/evaluators/policyEvaluationEngine
 *
 * The **Policy Evaluation Engine** (STEP 9) — extends the frozen Sprint-1 {@link PolicyEngine} for adaptive
 * routing. It runs the Sprint-1 communication/media/group/sync/security/priority policies (bias +
 * constraints + hard denials) AND the adaptive {@link DEFAULT_POLICY_HOOKS} (data-saver / battery-saver /
 * enterprise / security), folding everything into a single result that INFLUENCES SCORING: per-strategy
 * `bias`, route/strategy `vetoes`, and scoring-`weights` overrides. It composes Sprint 1 rather than
 * replacing it, so existing policy behaviour is preserved.
 *
 * @security Reads control-plane context + analysis + config only. A denial raises before any routing.
 */

import { PolicyEngine } from "../../communication-fabric/index.js";
import { DEFAULT_POLICY_HOOKS } from "./policyHooks.js";
import { PolicyConflictError } from "../errors.js";
import { AdaptiveEventType, RouteKind, StrategyType } from "../types/types.js";

export class PolicyEvaluationEngine {
  /**
   * @param {object} [deps]
   * @param {PolicyEngine} [deps.policyEngine] the Sprint-1 policy engine (default: fresh with defaults)
   * @param {object[]} [deps.hooks] adaptive hooks (default {@link DEFAULT_POLICY_HOOKS})
   * @param {object} [deps.config] base config bag (policy + hook config)
   * @param {import("../events/events.js").AdaptiveEventBus} [deps.events]
   */
  constructor(deps = {}) {
    this.policyEngine = deps.policyEngine ?? new PolicyEngine({ config: deps.config });
    this.hooks = deps.hooks ?? DEFAULT_POLICY_HOOKS;
    this.config = deps.config ?? {};
    this.events = deps.events ?? null;
  }

  /**
   * Evaluate policies + hooks against the context + analysis.
   * @param {object} context Sprint-1 context @param {object} analysis communication analysis
   * @param {object} [overrides] per-request config overrides (shallow-merged per namespace)
   * @returns {{ bias, constraints, weights, vetoRoutes, vetoStrategies, policyRefs, denied, notes }}
   */
  evaluate(context, analysis, overrides = {}) {
    const config = mergeConfig(this.config, overrides);

    // 1) Sprint-1 policies (bias + constraints + hard denial)
    const base = this.policyEngine.evaluate(context, overrides);
    if (base.denied) {
      return this._finalize(context, { ...base, weights: {}, vetoRoutes: [], vetoStrategies: [] });
    }

    // 2) adaptive hooks (bias + vetoes + weights + possible denial)
    const bias = { ...base.bias };
    let constraints = { ...base.constraints };
    const weights = {};
    const vetoRoutes = new Set();
    const vetoStrategies = new Set();
    const policyRefs = [...base.policyRefs];
    const notes = [...(base.notes ?? [])];

    for (const hook of this.hooks) {
      let out;
      try {
        out = hook.evaluate(context, analysis, config) ?? {};
      } catch {
        continue;
      }
      if (out.deny) {
        return this._finalize(context, { bias, constraints, weights, vetoRoutes: [...vetoRoutes], vetoStrategies: [...vetoStrategies], policyRefs, notes, denied: { policyId: hook.id, note: out.note ?? "denied by hook" } });
      }
      if (Object.keys(out).length) policyRefs.push(hook.id);
      if (out.note) notes.push({ policyId: hook.id, kind: hook.kind, note: out.note });
      if (out.bias) for (const [k, v] of Object.entries(out.bias)) bias[k] = (bias[k] ?? 0) + v;
      if (out.weights) for (const [k, v] of Object.entries(out.weights)) weights[k] = v;
      if (out.vetoRoutes) for (const r of out.vetoRoutes) vetoRoutes.add(r);
      if (out.vetoStrategies) for (const s of out.vetoStrategies) vetoStrategies.add(s);
    }

    this._assertNoConflict([...vetoRoutes], [...vetoStrategies]);
    return this._finalize(context, { bias, constraints, weights, vetoRoutes: [...vetoRoutes], vetoStrategies: [...vetoStrategies], policyRefs, notes, denied: null });
  }

  /** Guard against a hook set that vetoes every possible route (a self-contradictory policy config). */
  _assertNoConflict(vetoRoutes, vetoStrategies) {
    const allRoutes = Object.values(RouteKind);
    if (vetoRoutes.length >= allRoutes.length) throw new PolicyConflictError("Policies vetoed every route", { details: { vetoRoutes } });
    const allStrategies = Object.values(StrategyType);
    if (vetoStrategies.length >= allStrategies.length) throw new PolicyConflictError("Policies vetoed every strategy", { details: { vetoStrategies } });
  }

  _finalize(context, result) {
    this.events?.emit(AdaptiveEventType.POLICIES_EVALUATED, { requestId: context.requestId, policyRefs: result.policyRefs, vetoRoutes: result.vetoRoutes, denied: !!result.denied });
    return result;
  }
}

function mergeConfig(base, overrides) {
  if (!overrides || Object.keys(overrides).length === 0) return base;
  const out = { ...base };
  for (const [ns, val] of Object.entries(overrides)) out[ns] = { ...(base?.[ns] ?? {}), ...(val ?? {}) };
  return out;
}

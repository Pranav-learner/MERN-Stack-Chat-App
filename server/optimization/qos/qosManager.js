/**
 * @module optimization/qos/qosManager
 *
 * The **QoS Manager** (STEP 5) — classifies each communication into a priority class (critical / high /
 * normal / background), assigns its isolated queue lane + fair-scheduling weight, and folds the adaptive
 * resource policies that can DYNAMICALLY influence the decision (upgrade to critical, downgrade to
 * background, prefer a scheduling mode, cap concurrency, or deny admission). A CRITICAL classification is
 * a sticky floor — a downgrade policy can never demote critical signalling — which is how starvation of
 * high-priority traffic is prevented at classification time (the scheduler adds aging on top).
 *
 * @performance O(policies) constant-time fold; pure + synchronous.
 * @security Reads control-plane analysis + abstract budget numbers only. No content.
 */

import { baseClassFor, laneFor, weightFor, maxClass } from "./qosClasses.js";
import { DEFAULT_RESOURCE_POLICIES } from "../resources/resourcePolicies.js";
import { QoSClass, DEFAULT_QOS_WEIGHTS, OptimizationEventType } from "../types/types.js";
import { QoSConflictError } from "../errors.js";

export class QoSManager {
  /**
   * @param {object} [deps]
   * @param {object[]} [deps.policies] adaptive resource policies (default {@link DEFAULT_RESOURCE_POLICIES})
   * @param {object} [deps.weights] fair-scheduling weights (default {@link DEFAULT_QOS_WEIGHTS})
   * @param {object} [deps.config] policy config bag
   * @param {import("../events/events.js").OptimizationEventBus} [deps.events]
   */
  constructor(deps = {}) {
    this.policies = deps.policies ?? DEFAULT_RESOURCE_POLICIES;
    this.weights = { ...DEFAULT_QOS_WEIGHTS, ...(deps.weights ?? {}) };
    this.config = deps.config ?? {};
    this.events = deps.events ?? null;
  }

  /**
   * Evaluate the QoS + policy decision for a communication.
   * @param {object} bundle `{ context, analysis, resources }`
   * @param {object} [overrides] `{ qosClass?, mode? }` explicit per-request overrides + policy config overrides
   * @returns {{ qosClass, lane, weight, mode, capMultiplier, deferBackground, denied, policyRefs, reasons }}
   */
  evaluate(bundle, overrides = {}) {
    const { analysis } = bundle;
    const config = mergeConfig(this.config, overrides.policyOverrides ?? overrides);

    // base class from priority, or an explicit request override
    let qosClass = overrides.qosClass ?? baseClassFor(analysis.priority);
    let locked = qosClass === QoSClass.CRITICAL;
    let mode = overrides.mode ?? null;
    let capMultiplier = 1;
    let deferBackground = false;
    let denied = null;
    const policyRefs = [];
    const reasons = [];

    for (const policy of this.policies) {
      let out;
      try {
        out = policy.evaluate({ ...bundle, config }) ?? {};
      } catch {
        continue;
      }
      if (Object.keys(out).length) policyRefs.push(policy.id);
      if (out.note) reasons.push({ policyId: policy.id, note: out.note });
      if (out.deny) {
        denied = { policyId: policy.id, note: out.note ?? "denied by policy" };
        break;
      }
      if (out.qosClass) {
        if (out.qosClass === QoSClass.CRITICAL) {
          qosClass = QoSClass.CRITICAL;
          locked = true;
        } else if (!locked) {
          qosClass = out.qosClass;
        }
      }
      if (out.mode && !mode) mode = out.mode;
      if (out.capMultiplier != null) capMultiplier = Math.min(capMultiplier, out.capMultiplier); // most-restrictive cap wins
      if (out.deferBackground) deferBackground = true;
    }

    const lane = laneFor(qosClass);
    const weight = weightFor(qosClass, this.weights);
    if (!lane) throw new QoSConflictError(`No lane for QoS class "${qosClass}"`, { details: { qosClass } });

    const decision = { qosClass, lane, weight, mode, capMultiplier, deferBackground, denied, policyRefs, reasons };
    this.events?.emit(OptimizationEventType.QOS_EVALUATED, { requestId: bundle.context?.requestId, qosClass, lane, denied: !!denied });
    return decision;
  }

  /** Upgrade helper — enforce a class floor (used by fair scheduling / manual overrides). */
  floor(qosClass, floorClass) {
    return maxClass(qosClass, floorClass);
  }
}

function mergeConfig(base, overrides) {
  if (!overrides || Object.keys(overrides).length === 0) return base;
  const out = { ...base };
  for (const [ns, val] of Object.entries(overrides)) out[ns] = typeof val === "object" && val ? { ...(base?.[ns] ?? {}), ...val } : val;
  return out;
}

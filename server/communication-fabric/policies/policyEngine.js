/**
 * @module communication-fabric/policies/policyEngine
 *
 * The **Policy Engine** (STEP 8) — evaluates the configured {@link PolicySet} against an immutable context
 * and folds every applicable policy's output into a single result: merged strategy `bias`, merged
 * `constraints`, the list of applied policy ids (`policyRefs`), and — if any policy vetoes — a `denied`
 * verdict with the offending policy. The Decision Engine consumes `bias` + `constraints`; the manager
 * enforces `denied` by aborting the request with a {@link PolicyDeniedError}.
 *
 * Policies are CONFIGURABLE: the engine holds a base config bag, and each request may pass
 * `policyOverrides` that are shallow-merged on top for that evaluation only. This is how per-request +
 * per-deployment tuning happens without touching policy code.
 *
 * @performance O(P) over applicable policies — each is a constant-time slice read. No I/O.
 */

import { PolicySet } from "./policy.js";
import { DEFAULT_POLICIES } from "./defaultPolicies.js";
import { PolicyDeniedError, MissingPolicyError } from "../errors.js";
import { FabricEventType } from "../types/types.js";

export class PolicyEngine {
  /**
   * @param {object} [deps]
   * @param {PolicySet} [deps.policySet] default: all {@link DEFAULT_POLICIES}
   * @param {object} [deps.config] base config bag
   * @param {import("../events/events.js").FabricEventBus} [deps.events]
   */
  constructor(deps = {}) {
    this.policySet = deps.policySet ?? DEFAULT_POLICIES.reduce((set, p) => set.add(p), new PolicySet());
    this.config = deps.config ?? {};
    this.events = deps.events ?? null;
  }

  /** Register / replace a policy at runtime (configurable seam). */
  addPolicy(policy) {
    this.policySet.add(policy);
    return this;
  }

  /** Assert a policy id exists (used by validators). @throws {MissingPolicyError} */
  requirePolicy(id) {
    if (!this.policySet.has(id)) throw new MissingPolicyError(`Required policy "${id}" is not registered`, { details: { id } });
    return this.policySet.get(id);
  }

  /**
   * Evaluate all applicable policies against the context.
   * @param {import("../contexts/communicationContext.js").CommunicationContext} context
   * @param {object} [overrides] per-request policy config overrides (shallow-merged over base config)
   * @returns {{ bias: object, constraints: object, policyRefs: string[], denied: null | { policyId: string, note: string }, notes: object[] }}
   */
  evaluate(context, overrides = {}) {
    const config = mergeConfig(this.config, overrides);
    const bias = {};
    let constraints = {};
    const policyRefs = [];
    const notes = [];
    let denied = null;

    for (const policy of this.policySet.all()) {
      let applies = true;
      try {
        applies = policy.applies ? policy.applies(context, config) : true;
      } catch {
        applies = false;
      }
      if (!applies) continue;

      let out;
      try {
        out = policy.evaluate(context, config) ?? {};
      } catch {
        continue; // a faulty policy is skipped, never crashes evaluation
      }
      policyRefs.push(policy.id);
      if (out.note) notes.push({ policyId: policy.id, kind: policy.kind, note: out.note });
      if (out.bias) for (const [type, delta] of Object.entries(out.bias)) bias[type] = (bias[type] ?? 0) + delta;
      if (out.constraints) constraints = { ...constraints, ...out.constraints };
      if (out.deny && !denied) denied = { policyId: policy.id, note: out.note ?? "denied by policy" };
    }

    const result = { bias, constraints, policyRefs, denied, notes };
    this.events?.emit(FabricEventType.POLICIES_EVALUATED, { requestId: context.requestId, policyRefs, denied: !!denied });
    return result;
  }

  /**
   * Evaluate + enforce: throws if any policy denied. Returns the (non-denied) result the engine folds
   * into the decision.
   * @throws {PolicyDeniedError}
   */
  enforce(context, overrides = {}) {
    const result = this.evaluate(context, overrides);
    if (result.denied) {
      throw new PolicyDeniedError(`Communication denied by policy "${result.denied.policyId}": ${result.denied.note}`, {
        details: { policyId: result.denied.policyId, note: result.denied.note },
      });
    }
    return result;
  }
}

/** Shallow-merge overrides per top-level config namespace (messaging/media/group/...). */
function mergeConfig(base, overrides) {
  if (!overrides || Object.keys(overrides).length === 0) return base;
  const out = { ...base };
  for (const [ns, val] of Object.entries(overrides)) out[ns] = { ...(base?.[ns] ?? {}), ...(val ?? {}) };
  return out;
}

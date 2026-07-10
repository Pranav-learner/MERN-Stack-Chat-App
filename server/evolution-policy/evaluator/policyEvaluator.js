/**
 * @module evolution-policy/evaluator
 *
 * **Deterministic policy evaluation.** Given a session's policy set + an evaluation
 * subject (timestamps, generation) + a context (now, message count, session age, device /
 * security events), decide which policies fire. Evaluation is a PURE function of its
 * inputs — the same subject + context always yields the same result, which makes automatic
 * rekeying reproducible and testable.
 *
 * Shared policy kinds delegate to the Sprint 1 evaluator (no redesign); the Sprint 3
 * `session-age` kind is handled here.
 *
 * @security Pure decision logic — no cryptography, no key material, no side effects.
 */

import { evaluatePolicy as evaluateSharedPolicy } from "../../session-evolution/policies/policies.js";
import { PolicyType } from "../types/types.js";
import { RekeyValidationError } from "../errors.js";

/**
 * Evaluate ONE policy.
 * @param {import("../../session-evolution/types/types.js").PolicyDescriptor} policy
 * @param {{ createdAt?: string, lastEvolutionAt?: string|null }} subject session-derived state (for time-based)
 * @param {object} [context] `{ now, messagesSinceLastEvolution, sessionAgeMs, manual, securityEvent, deviceEvent, administrator }`
 * @returns {{ policyId: string, type: string, triggered: boolean, reason?: string }}
 */
export function evaluatePolicy(policy, subject, context = {}) {
  if (!policy || typeof policy !== "object") {
    throw new RekeyValidationError("Cannot evaluate a malformed policy");
  }
  if (policy.enabled === false) return { policyId: policy.id, type: policy.type, triggered: false };

  if (policy.type === PolicyType.SESSION_AGE) {
    const age = context.sessionAgeMs ?? 0;
    const triggered = age >= policy.params.maxAgeMs;
    return { policyId: policy.id, type: policy.type, triggered, reason: triggered ? "session-age reached" : undefined };
  }
  // All other kinds reuse the Sprint 1 evaluator verbatim.
  return evaluateSharedPolicy(policy, subject, context);
}

/**
 * Evaluate a whole policy set, deterministically, in declaration order.
 * @param {import("../../session-evolution/types/types.js").PolicyDescriptor[]} policies
 * @param {{ createdAt?: string, lastEvolutionAt?: string|null }} subject
 * @param {object} [context]
 * @returns {{ results: object[], triggered: object[], anyTriggered: boolean, firstTrigger: object|null }}
 */
export function evaluatePolicies(policies, subject, context = {}) {
  const results = (policies ?? []).map((p) => evaluatePolicy(p, subject, context));
  const triggered = results.filter((r) => r.triggered);
  return { results, triggered, anyTriggered: triggered.length > 0, firstTrigger: triggered[0] ?? null };
}

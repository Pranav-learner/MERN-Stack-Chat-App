/**
 * @module communication-fabric/decision-engine/communicationDecision
 *
 * The **Communication Decision** value object — the Decision Engine's output describing HOW communication
 * should occur, without executing it. It names the selected strategy, the primary route, the ordered
 * subsystems the strategy will delegate to, the engine's confidence, an ordered audit of the reasons that
 * produced it, and any policy-derived constraints. It is frozen once created and is the sole input to the
 * routing + execution-planning stages.
 *
 * @security Pure control-plane metadata — ids, enum classifications, rule notes, policy ids. No content.
 */

import { DecisionConfidence, FABRIC_SCHEMA_VERSION } from "../types/types.js";
import { deepFreeze } from "../contexts/communicationContext.js";

/**
 * Build a frozen communication decision.
 * @param {object} spec
 * @param {string} spec.decisionId @param {string} spec.requestId
 * @param {string} spec.strategyType @param {string} spec.primaryRoute
 * @param {string[]} spec.subsystems @param {string} [spec.confidence]
 * @param {object[]} [spec.reasons] ordered `{ rule, effect, note }` contributions
 * @param {string[]} [spec.policyRefs] @param {object} [spec.constraints]
 * @param {object} [spec.scoring] per-strategy score breakdown (diagnostics)
 * @param {string} spec.createdAt
 * @returns {import("../types/types.js").CommunicationDecision}
 */
export function createDecision(spec) {
  return deepFreeze({
    decisionId: spec.decisionId,
    requestId: spec.requestId,
    strategyType: spec.strategyType,
    primaryRoute: spec.primaryRoute,
    subsystems: [...(spec.subsystems ?? [])],
    confidence: spec.confidence ?? DecisionConfidence.LIKELY,
    reasons: [...(spec.reasons ?? [])],
    policyRefs: [...(spec.policyRefs ?? [])],
    constraints: spec.constraints ?? {},
    scoring: spec.scoring ?? {},
    createdAt: spec.createdAt,
    schemaVersion: FABRIC_SCHEMA_VERSION,
    version: 1,
  });
}

/**
 * Derive a confidence level from how the decision was reached:
 * - DEFINITIVE — a single strategy matched with a clear margin AND no context facet was inferred.
 * - LIKELY     — a clear best match, but some context was inferred/defaulted.
 * - TENTATIVE  — the match was close / relied on UNKNOWN availability / defaults only.
 * @param {object} args @param {number} args.margin winning score minus runner-up @param {number} args.candidates
 * @param {number} args.inferredCount how many context facets were inferred
 */
export function deriveConfidence({ margin, candidates, inferredCount }) {
  if (candidates <= 1 && inferredCount === 0) return DecisionConfidence.DEFINITIVE;
  if (margin >= 2 && inferredCount <= 1) return DecisionConfidence.LIKELY;
  if (margin <= 0) return DecisionConfidence.TENTATIVE;
  return inferredCount === 0 ? DecisionConfidence.LIKELY : DecisionConfidence.TENTATIVE;
}

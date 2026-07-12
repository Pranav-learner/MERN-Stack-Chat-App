/**
 * @module communication-fabric/decision-engine/decisionEngine
 *
 * The **Decision Engine** (STEP 4) — determines HOW communication should occur WITHOUT executing it. It
 * is the brain of the Fabric pipeline, and it is deliberately declarative:
 *
 *   1. Ask the strategy REGISTRY which strategies `support` this context, each returning a base score.
 *   2. Run the ordered, pluggable DECISION RULES to add bias + reasons + constraints.
 *   3. Fold in any policy-derived bias/constraints from the already-evaluated policy result.
 *   4. Select the highest-scoring supported strategy (ties broken by registry order — deterministic).
 *   5. Ask the winning strategy to `describe` its primary route + subsystem order.
 *   6. Derive a confidence from the score margin + how much context was inferred.
 *
 * Selection therefore happens THROUGH the strategy interface + rule interface — never a hard-coded
 * conditional cascade (STEP 6). Everything is pluggable; the engine itself contains no per-type branches.
 *
 * @performance Pure + synchronous. For N registered strategies + M rules it is O(N + M) table math, and
 * the manager caches decisions by a context fingerprint so repeat traffic skips the engine entirely.
 *
 * @security Reads the control-plane context only; emits a control-plane decision only.
 */

import { createDecision, deriveConfidence } from "./communicationDecision.js";
import { DEFAULT_DECISION_RULES } from "./decisionRules.js";
import { NoStrategyMatchedError } from "../errors.js";
import { FabricFailureReason } from "../types/types.js";

/**
 * @typedef {object} DecisionEngineDeps
 * @property {import("../strategies/strategy.js").StrategyRegistry} strategyRegistry required
 * @property {object[]} [rules] ordered decision rules (default {@link DEFAULT_DECISION_RULES})
 * @property {() => string} [idGenerator] decision id generator
 * @property {() => number} [clock]
 */

export class DecisionEngine {
  /** @param {DecisionEngineDeps} deps */
  constructor(deps = {}) {
    if (!deps.strategyRegistry) throw new Error("DecisionEngine requires a strategyRegistry");
    this.strategyRegistry = deps.strategyRegistry;
    this.rules = deps.rules ?? DEFAULT_DECISION_RULES;
    this.idGenerator = deps.idGenerator ?? (() => `dec_${Math.abs(hashString(String(Date.now())))}`);
    this.clock = deps.clock ?? (() => Date.now());
  }

  /**
   * Decide how a communication should occur.
   * @param {import("../contexts/communicationContext.js").CommunicationContext} context
   * @param {object} [opts]
   * @param {object} [opts.policyResult] the {@link PolicyEngine} output (bias/constraints/refs)
   * @param {string} [opts.decisionId] override id (idempotency)
   * @returns {import("../types/types.js").CommunicationDecision}
   */
  decide(context, opts = {}) {
    const at = new Date(this.clock()).toISOString();

    // 1) candidate strategies from the registry (interface-driven; no conditionals here)
    const candidates = this.strategyRegistry.candidates(context); // [{ type, strategy, baseScore }]
    if (candidates.length === 0) {
      throw new NoStrategyMatchedError("No strategy supports this communication context", {
        reason: FabricFailureReason.NO_STRATEGY_MATCHED,
        details: { type: context.type, conversation: context.conversation.type },
      });
    }

    // running score per strategy type, seeded by the strategy's own base score
    const scores = new Map();
    for (const c of candidates) scores.set(c.type, c.baseScore);
    const reasons = [];
    let constraints = {};

    // 2) pluggable decision rules → additive bias + reasons + constraints
    for (const rule of this.rules) {
      let out;
      try {
        out = rule.evaluate(context, { scores: new Map(scores) }) ?? {};
      } catch {
        continue; // a faulty rule never breaks a decision
      }
      if (out.bias) for (const [type, delta] of Object.entries(out.bias)) if (scores.has(type)) scores.set(type, scores.get(type) + delta);
      if (out.reason) reasons.push({ rule: rule.id, ...out.reason });
      if (out.constraints) constraints = { ...constraints, ...out.constraints };
    }

    // 3) fold in policy-derived bias + constraints (policy already evaluated upstream)
    const policyResult = opts.policyResult ?? null;
    if (policyResult) {
      if (policyResult.bias) for (const [type, delta] of Object.entries(policyResult.bias)) if (scores.has(type)) scores.set(type, scores.get(type) + delta);
      if (policyResult.constraints) constraints = { ...constraints, ...policyResult.constraints };
    }

    // 4) select the winner deterministically (max score; ties → earliest registry order)
    const ordered = candidates.map((c) => ({ type: c.type, score: scores.get(c.type) })).sort((a, b) => b.score - a.score);
    const winner = ordered[0];
    const runnerUp = ordered[1];
    const margin = runnerUp ? winner.score - runnerUp.score : winner.score;

    // 5) ask the winning strategy to describe its route + subsystem order (interface, not branch)
    const strategy = this.strategyRegistry.get(winner.type);
    const shape = strategy.describe(context, { constraints });

    // 6) confidence from margin + inferred-context count
    const inferredCount = context.diagnostics.inferredFacets.length;
    const confidence = deriveConfidence({ margin, candidates: candidates.length, inferredCount });

    return createDecision({
      decisionId: opts.decisionId ?? this.idGenerator(),
      requestId: context.requestId,
      strategyType: winner.type,
      primaryRoute: shape.primaryRoute,
      subsystems: shape.subsystems,
      confidence,
      reasons,
      policyRefs: policyResult?.policyRefs ?? [],
      constraints,
      scoring: Object.fromEntries(ordered.map((o) => [o.type, o.score])),
      createdAt: at,
    });
  }
}

/** Small deterministic string hash (avoids Math.random for reproducibility in id fallback). */
export function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

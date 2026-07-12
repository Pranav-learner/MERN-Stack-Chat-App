/**
 * @module adaptive-routing/integration/fabricIntegration
 *
 * **Sprint-1 ↔ Sprint-2 integration** — the glue that makes the existing Communication Fabric intelligent
 * WITHOUT redesigning it. It builds the stateless adaptive collaborators once and returns the two things
 * the frozen `CommunicationFabricManager` already accepts as optional deps:
 *
 *   - `decisionRules` — an adaptive decision rule that scores routes and biases the Fabric's Decision
 *     Engine toward the top-ranked strategy *that is also one of the engine's native candidates*. The rule
 *     reads the candidate set from the draft the engine passes it, so it re-orders selection by adaptive
 *     score without ever naming a non-candidate strategy. (Relay-as-primary — an adaptive-only candidate —
 *     is available through the standalone `/api/adaptive-routing` engine, which builds its own plan.)
 *   - `routePlanner` — an {@link AdaptiveRoutePlanner} that replaces the deterministic Sprint-1 planner,
 *     attaching scored, ranked fallback routes + `adaptive: true` diagnostics to every plan.
 *
 * Spread the result into the manager: `new CommunicationFabricManager({ ...repo, ...createFabricAdaptiveIntegration() })`.
 *
 * @security Pure control-plane wiring; the rule + planner read the same metadata the engine already sees.
 */

import { CapabilityEngine } from "../capability/capabilityEngine.js";
import { CommunicationAnalyzer } from "../analyzers/communicationAnalyzer.js";
import { NetworkAnalyzer } from "../analyzers/networkAnalyzer.js";
import { CandidateBuilder } from "../routing/candidateBuilder.js";
import { RouteScoringEngine } from "../scoring/routeScoringEngine.js";
import { PolicyEvaluationEngine } from "../evaluators/policyEvaluationEngine.js";
import { AdaptiveRoutePlanner } from "../planners/adaptiveRoutePlanner.js";
import { createDefaultStrategyRegistry } from "../_fabric.js";
import { DEFAULT_SCORE_WEIGHTS } from "../types/types.js";

/** The bias magnitude the adaptive rule applies to the scoring winner (dominates Sprint-1 base scores). */
const ADAPTIVE_BIAS = 50;

/**
 * Build the adaptive collaborators + the Fabric-facing rule/planner.
 * @param {object} [deps]
 * @param {import("../_fabric.js").StrategyRegistry} [deps.strategyRegistry] must match the manager's registry
 * @param {object} [deps.providers] `{ capability, network }` @param {object} [deps.config] `{ weights, policyConfig }`
 * @param {object[]} [deps.scorers] @param {object[]} [deps.policyHooks]
 * @param {import("../_fabric.js").FabricEventBus} [deps.fabricEvents]
 * @param {() => number} [deps.clock]
 * @returns {{ decisionRules: object[], routePlanner: AdaptiveRoutePlanner, components: object }}
 */
export function createFabricAdaptiveIntegration(deps = {}) {
  const strategyRegistry = deps.strategyRegistry ?? createDefaultStrategyRegistry();
  const clock = deps.clock ?? (() => Date.now());

  const capabilityEngine = new CapabilityEngine({ capabilityProvider: deps.providers?.capability, clock });
  const communicationAnalyzer = new CommunicationAnalyzer();
  const networkAnalyzer = new NetworkAnalyzer({ networkStateProvider: deps.providers?.network });
  const candidateBuilder = new CandidateBuilder({ strategyRegistry });
  const scoringEngine = new RouteScoringEngine({ scorers: deps.scorers, weights: { ...DEFAULT_SCORE_WEIGHTS, ...(deps.config?.weights ?? {}) } });
  const policyEngine = new PolicyEvaluationEngine({ hooks: deps.policyHooks, config: deps.config?.policyConfig });

  const components = { capabilityEngine, communicationAnalyzer, networkAnalyzer, candidateBuilder, scoringEngine, policyEngine };

  /** Score routes synchronously + return the ranked list (pure of args → concurrency-safe). */
  const rankFor = (context) => {
    const raw = context.raw ?? context;
    const analysis = communicationAnalyzer.analyze(context);
    const { negotiated } = capabilityEngine.collect({ senderId: raw.conversation?.senderId, receiverIds: raw.recipient?.ids });
    const network = networkAnalyzer.analyze(context);
    const policyResult = policyEngine.evaluate(context, analysis);
    const candidates = candidateBuilder.build(context, { capabilities: negotiated, network });
    return { ranked: scoringEngine.score(candidates, { context, analysis, network, capabilities: negotiated, policyResult }), policyResult };
  };

  /**
   * The adaptive decision rule. It biases the Fabric's Decision Engine toward the highest-ranked strategy
   * that IS one of the engine's native candidates (read from the draft), so selection follows the adaptive
   * score without ever naming a non-candidate strategy.
   */
  const adaptiveRule = {
    id: "adaptive-scoring",
    describe: "Biases strategy selection by adaptive route scores (capabilities + network + policy).",
    evaluate(context, draft) {
      let ranked;
      try {
        ({ ranked } = rankFor(context));
      } catch {
        return {}; // never break the Fabric decision — fall back to Sprint-1 heuristics
      }
      const candidateTypes = draft?.scores instanceof Map ? new Set(draft.scores.keys()) : null;
      const winner = ranked.find((r) => r.viable && (!candidateTypes || candidateTypes.has(r.strategyType)));
      if (!winner) return {};
      return { bias: { [winner.strategyType]: ADAPTIVE_BIAS }, reason: { effect: "adaptive-select", note: `scored ${winner.strategyType}/${winner.routeKind} @ ${winner.total}` } };
    },
  };

  const routePlanner = new AdaptiveRoutePlanner({ ...components, events: deps.fabricEvents });

  return { decisionRules: [adaptiveRule], routePlanner, components };
}

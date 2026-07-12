/**
 * @module adaptive-routing/planners/adaptiveRoutePlanner
 *
 * The **Adaptive Route Planner** — the drop-in replacement for the Sprint-1 deterministic `RoutePlanner`.
 * It implements the SAME `planRoute(decision, context)` contract (so it slots straight into the Sprint-1
 * `ExecutionPlanner` / `CommunicationFabricManager` via the `routePlanner` seam), but instead of attaching
 * a static fallback chain it SCORES the candidate routes and returns the ranked alternatives + an adaptive
 * diagnostics block (`adaptive: true` + the score table). This is how the existing Communication Fabric
 * becomes intelligent without any pipeline change.
 *
 * It is PURE with respect to its arguments + injected stateless collaborators, so it is safe under
 * concurrency (no shared mutable state across `planRoute` calls).
 *
 * @security Returns route metadata (kinds + scores + diagnostics) only. No content.
 */

import { createRoute } from "../../communication-fabric/routing/route.js";
import { FabricEventType } from "../../communication-fabric/index.js";

export class AdaptiveRoutePlanner {
  /**
   * @param {object} deps the stateless adaptive collaborators
   * @param {import("../capability/capabilityEngine.js").CapabilityEngine} deps.capabilityEngine
   * @param {import("../analyzers/communicationAnalyzer.js").CommunicationAnalyzer} deps.communicationAnalyzer
   * @param {import("../analyzers/networkAnalyzer.js").NetworkAnalyzer} deps.networkAnalyzer
   * @param {import("../routing/candidateBuilder.js").CandidateBuilder} deps.candidateBuilder
   * @param {import("../scoring/routeScoringEngine.js").RouteScoringEngine} deps.scoringEngine
   * @param {import("../evaluators/policyEvaluationEngine.js").PolicyEvaluationEngine} deps.policyEngine
   * @param {import("../../communication-fabric/index.js").FabricEventBus} [deps.events] the Fabric bus (for RoutePlanned)
   */
  constructor(deps = {}) {
    for (const k of ["capabilityEngine", "communicationAnalyzer", "networkAnalyzer", "candidateBuilder", "scoringEngine", "policyEngine"]) {
      if (!deps[k]) throw new Error(`AdaptiveRoutePlanner requires ${k}`);
    }
    this.capabilityEngine = deps.capabilityEngine;
    this.communicationAnalyzer = deps.communicationAnalyzer;
    this.networkAnalyzer = deps.networkAnalyzer;
    this.candidateBuilder = deps.candidateBuilder;
    this.scoringEngine = deps.scoringEngine;
    this.policyEngine = deps.policyEngine;
    this.events = deps.events ?? null;
  }

  /**
   * Plan the route for a Fabric decision by scoring candidates — same contract as the Sprint-1 planner.
   * @param {object} decision Sprint-1 CommunicationDecision
   * @param {object} context Sprint-1 context
   * @returns {object} route metadata (frozen)
   */
  planRoute(decision, context) {
    const raw = context.raw ?? context;
    const analysis = this.communicationAnalyzer.analyze(context);
    const { negotiated } = this.capabilityEngine.collect({ senderId: raw.conversation?.senderId, receiverIds: raw.recipient?.ids });
    const network = this.networkAnalyzer.analyze(context);
    const policyResult = this.policyEngine.evaluate(context, analysis);
    const candidates = this.candidateBuilder.build(context, { capabilities: negotiated, network });
    const ranked = this.scoringEngine.score(candidates, { context, analysis, network, capabilities: negotiated, policyResult });

    // primary = the decision's chosen route (already selected by the adaptive decision rule); candidates =
    // the ranked alternatives (viable first), which the Sprint-1 orchestrator can fall back through.
    const alternatives = ranked.filter((r) => r.routeKind !== decision.primaryRoute).map((r) => r.routeKind);
    const route = createRoute({
      primary: decision.primaryRoute,
      candidates: dedupe(alternatives),
      diagnostics: {
        strategy: decision.strategyType,
        derivedFrom: "adaptive-scoring",
        adaptive: true, // Sprint 2 flips this on (Sprint 1 was false)
        scores: ranked.map((r) => ({ strategy: r.strategyType, route: r.routeKind, total: r.total, viable: r.viable })),
        policyRefs: policyResult.policyRefs,
      },
    });
    this.events?.emit(FabricEventType.ROUTE_PLANNED, { requestId: decision.requestId, decisionId: decision.decisionId, primary: decision.primaryRoute, adaptive: true });
    return route;
  }
}

function dedupe(list) {
  return [...new Set(list)];
}

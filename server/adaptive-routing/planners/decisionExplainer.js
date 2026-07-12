/**
 * @module adaptive-routing/planners/decisionExplainer
 *
 * The **Decision Explainer** — turns the internal scoring artifacts into a structured, human-readable
 * EXPLANATION of why the winning strategy + route was chosen and why the alternatives were not. This is
 * what makes adaptive routing auditable: instead of an opaque "it picked relay", a client/dashboard gets
 * the winning score breakdown, the decisive dimensions, the rejected candidates (with their hard-fail
 * reasons), the policy influence, and one-line capability + network summaries.
 *
 * @security The explanation is scores + classification metadata + notes only. No content.
 */

import { AdaptiveEventType } from "../types/types.js";

export class DecisionExplainer {
  /** @param {object} [deps] @param {import("../events/events.js").AdaptiveEventBus} [deps.events] */
  constructor(deps = {}) {
    this.events = deps.events ?? null;
  }

  /**
   * Explain a selection.
   * @param {object} args `{ requestId, analysis, network, capabilities, ranked, selection, policyResult, fallbackPlan }`
   * @returns {object} the explanation
   */
  explain(args) {
    const { requestId, analysis, network, capabilities, ranked, selection, policyResult, fallbackPlan } = args;
    const winner = ranked.find((r) => r.strategyType === selection.strategyType && r.routeKind === selection.routeKind) ?? ranked[0];

    // the decisive dimensions = winner's highest-contributing scored dimensions
    const topDimensions = Object.entries(winner?.breakdown ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([dimension, score]) => ({ dimension, score }));

    const rejected = ranked
      .filter((r) => r !== winner)
      .map((r) => ({ strategy: r.strategyType, route: r.routeKind, total: r.total, viable: r.viable, hardFails: r.reasons.filter((x) => x.hardFail).map((x) => `${x.dimension}: ${x.note}`) }));

    const explanation = {
      requestId,
      summary: `Selected ${selection.strategyType} over ${selection.routeKind} (score ${winner?.total ?? selection.score})${selection.adaptive ? " [adaptive candidate]" : ""}${selection.ambiguous ? " [tie-broken]" : ""}.`,
      chosen: { strategy: selection.strategyType, route: selection.routeKind, score: winner?.total ?? selection.score },
      why: (winner?.reasons ?? []).map((r) => `${r.dimension} (${r.score}×w${r.weight}): ${r.note}`),
      topDimensions,
      rejected,
      policyInfluence: { refs: policyResult?.policyRefs ?? [], bias: policyResult?.bias ?? {}, vetoRoutes: policyResult?.vetoRoutes ?? [], notes: (policyResult?.notes ?? []).map((n) => n.note) },
      capabilitySummary: { transports: capabilities?.transports ?? [], features: capabilities?.features ?? [], protocolVersion: capabilities?.protocolVersion },
      networkSummary: network?.availability ?? {},
      fallbackSummary: (fallbackPlan?.fallbacks ?? []).map((f) => `${f.strategyType}/${f.routeKind} (${f.reason})`),
    };

    this.events?.emit(AdaptiveEventType.DECISION_EXPLAINED, { requestId, strategy: selection.strategyType, route: selection.routeKind });
    return explanation;
  }
}

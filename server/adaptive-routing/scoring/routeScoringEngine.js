/**
 * @module adaptive-routing/scoring/routeScoringEngine
 *
 * The **Route Scoring Engine** (STEP 6) — runs every pluggable scorer over every candidate route, folds
 * the sub-scores with CONFIGURABLE weights into a normalized total, marks viability (a scorer `hardFail`
 * vetoes a candidate), and returns the candidates RANKED best-first. This is the heart of adaptive
 * routing: the decision of which transport / strategy to use emerges from weighted scores, not conditionals.
 *
 * Scorers + weights are both pluggable, so a deployment tunes routing behaviour (favour direct, penalise
 * relay, weight cost for a data-saver profile) without code changes. Ties break deterministically by
 * candidate order, so ranking is reproducible — which is what makes evaluation caching + tests stable.
 *
 * @performance O(candidates × scorers) constant-time weighted sums; pure + synchronous, no I/O.
 * @security Emits numeric scores + classification metadata only.
 */

import { createRouteScore } from "./routeScore.js";
import { DEFAULT_SCORERS } from "./scorers.js";
import { DEFAULT_SCORE_WEIGHTS, MIN_VIABLE_SCORE, AdaptiveEventType } from "../types/types.js";

export class RouteScoringEngine {
  /**
   * @param {object} [deps]
   * @param {object[]} [deps.scorers] ordered scorers (default {@link DEFAULT_SCORERS})
   * @param {Object<string, number>} [deps.weights] per-dimension weights (default {@link DEFAULT_SCORE_WEIGHTS})
   * @param {import("../events/events.js").AdaptiveEventBus} [deps.events]
   */
  constructor(deps = {}) {
    this.scorers = deps.scorers ?? DEFAULT_SCORERS;
    this.weights = { ...DEFAULT_SCORE_WEIGHTS, ...(deps.weights ?? {}) };
    this.events = deps.events ?? null;
  }

  /**
   * Score + rank candidate routes.
   * @param {{ strategyType: string, routeKind: string }[]} candidates
   * @param {object} bundle `{ context, analysis, network, capabilities, policyResult, weights? }`
   * @returns {import("../types/types.js").RouteScore[]} ranked best-first
   */
  score(candidates, bundle = {}) {
    const weights = bundle.weights ? { ...this.weights, ...bundle.weights } : this.weights;
    const scored = candidates.map((candidate) => this._scoreOne(candidate, bundle, weights));

    scored.sort((a, b) => {
      if (a.viable !== b.viable) return a.viable ? -1 : 1; // viable first
      if (b.total !== a.total) return b.total - a.total; // higher total first
      return 0; // stable → preserves candidate (registry) order as the deterministic tie-break
    });

    const ranked = scored.map((s, i) => createRouteScore({ ...s, rank: i }));
    this.events?.emit(AdaptiveEventType.ROUTES_SCORED, {
      requestId: bundle.context?.requestId,
      count: ranked.length,
      ranking: ranked.map((r) => ({ strategy: r.strategyType, route: r.routeKind, total: r.total, viable: r.viable })),
    });
    return ranked;
  }

  _scoreOne(candidate, bundle, weights) {
    const breakdown = {};
    const reasons = [];
    let weightedSum = 0;
    let weightTotal = 0;
    let hardFail = false;

    for (const scorer of this.scorers) {
      const weight = weights[scorer.dimension] ?? 0;
      let out;
      try {
        out = scorer.score(candidate, bundle) ?? { score: 0.5 };
      } catch {
        out = { score: 0.5, note: "scorer error → neutral" };
      }
      const sub = clamp01(out.score);
      breakdown[scorer.dimension] = round4(sub);
      if (out.hardFail) hardFail = true;
      if (out.note) reasons.push({ dimension: scorer.dimension, score: round4(sub), weight, note: out.note, ...(out.hardFail ? { hardFail: true } : {}) });
      if (weight > 0) {
        weightedSum += sub * weight;
        weightTotal += weight;
      }
    }

    const total = weightTotal > 0 ? weightedSum / weightTotal : 0;
    const viable = !hardFail && total >= MIN_VIABLE_SCORE;
    return { routeKind: candidate.routeKind, strategyType: candidate.strategyType, adaptive: candidate.adaptive ?? false, total, viable, breakdown, reasons };
  }
}

function clamp01(n) {
  return typeof n !== "number" || Number.isNaN(n) ? 0.5 : n < 0 ? 0 : n > 1 ? 1 : n;
}
function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

/**
 * @module adaptive-routing/selectors/strategySelector
 *
 * The **Adaptive Strategy Selector** (STEP 7) — picks the winning strategy + route from the RANKED scores.
 * It contains NO hardcoded transport logic: it simply takes the highest-ranked VIABLE candidate the
 * scoring engine produced. If nothing is viable it raises {@link NoViableRouteError}; if the top two
 * candidates tie on total but disagree on strategy it records the ambiguity (deterministic tie-break by
 * rank) so the explanation can surface it. The Decision Engine thus selects strategies THROUGH the scoring
 * engine (Direct / Relay / Offline / Media / Synchronization / Hybrid) rather than through conditionals.
 *
 * @security Emits the selected strategy/route + score metadata only.
 */

import { NoViableRouteError } from "../errors.js";
import { AdaptiveEventType, AdaptiveFailureReason } from "../types/types.js";

export class StrategySelector {
  /** @param {object} [deps] @param {import("../events/events.js").AdaptiveEventBus} [deps.events] */
  constructor(deps = {}) {
    this.events = deps.events ?? null;
  }

  /**
   * Select the optimal strategy from ranked route scores.
   * @param {import("../types/types.js").RouteScore[]} ranked
   * @param {object} [ctx] `{ requestId }` for events
   * @returns {{ strategyType: string, routeKind: string, score: number, adaptive: boolean, ambiguous: boolean, runnerUp: object|null }}
   */
  select(ranked, ctx = {}) {
    const viable = ranked.filter((r) => r.viable);
    if (viable.length === 0) {
      throw new NoViableRouteError("No viable route scored above the viability floor", {
        reason: AdaptiveFailureReason.NO_VIABLE_ROUTE,
        details: { considered: ranked.map((r) => ({ strategy: r.strategyType, route: r.routeKind, total: r.total })) },
      });
    }
    const winner = viable[0];
    const runnerUp = viable[1] ?? null;
    // ambiguous when the runner-up ties on total but is a *different* strategy (surfaced, not fatal)
    const ambiguous = !!runnerUp && runnerUp.total === winner.total && runnerUp.strategyType !== winner.strategyType;

    const selection = { strategyType: winner.strategyType, routeKind: winner.routeKind, score: winner.total, adaptive: winner.adaptive, ambiguous, runnerUp: runnerUp ? { strategyType: runnerUp.strategyType, routeKind: runnerUp.routeKind, score: runnerUp.total } : null };
    this.events?.emit(AdaptiveEventType.STRATEGY_SELECTED, { requestId: ctx.requestId, strategy: selection.strategyType, route: selection.routeKind, score: selection.score, ambiguous });
    return selection;
  }
}

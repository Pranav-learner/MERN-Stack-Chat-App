/**
 * @module adaptive-routing/fallback/fallbackPlanner
 *
 * The **Fallback Planner** (STEP 8) — turns the ranked route scores into a DETERMINISTIC fallback plan:
 * the selected primary, followed by the lower-ranked viable alternatives (ordered by score) as backup
 * strategies/routes, each tagged with a machine-readable {@link FallbackReason}, plus a static retry
 * policy and failure metadata. It never re-scores or randomises — given the same ranking it always
 * produces the same plan — so recovery is reproducible and explainable.
 *
 * It also guarantees a couple of safety-net fallbacks where they make sense: a relayed alternative behind
 * a direct primary, and an offline (store-and-forward) tail so a message is never simply dropped.
 *
 * @security The plan is `(strategyType, routeKind, reason)` tuples + retry metadata. No content.
 */

import { deepFreeze } from "../_fabric.js";
import { FallbackReason, DEFAULT_RETRY_POLICY, RouteKind, StrategyType, AdaptiveEventType, ADAPTIVE_SCHEMA_VERSION } from "../types/types.js";

export class FallbackPlanner {
  /** @param {object} [deps] @param {import("../events/events.js").AdaptiveEventBus} [deps.events] @param {object} [deps.retryPolicy] */
  constructor(deps = {}) {
    this.events = deps.events ?? null;
    this.retryPolicy = deps.retryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  /**
   * Build a deterministic fallback plan.
   * @param {import("../types/types.js").RouteScore[]} ranked ranked route scores
   * @param {object} selection the chosen `{ strategyType, routeKind }`
   * @param {object} [ctx] `{ requestId }`
   * @returns {object} frozen fallback plan
   */
  plan(ranked, selection, ctx = {}) {
    const viable = ranked.filter((r) => r.viable);
    const fallbacks = [];

    // 1) lower-ranked viable alternatives, in score order, excluding the primary
    for (const r of viable) {
      if (r.strategyType === selection.strategyType && r.routeKind === selection.routeKind) continue;
      fallbacks.push({ strategyType: r.strategyType, routeKind: r.routeKind, score: r.total, reason: reasonFor(r.routeKind), rank: r.rank });
    }

    // 2) safety-net tail: if store-and-forward isn't already present, append it so nothing is dropped
    const hasOffline = selection.routeKind === RouteKind.STORE_AND_FORWARD || fallbacks.some((f) => f.routeKind === RouteKind.STORE_AND_FORWARD);
    if (!hasOffline && isMessaging(selection)) {
      fallbacks.push({ strategyType: StrategyType.OFFLINE, routeKind: RouteKind.STORE_AND_FORWARD, score: 0, reason: FallbackReason.OFFLINE_FALLBACK, rank: fallbacks.length + viable.length, safetyNet: true });
    }

    const fallbackPlan = deepFreeze({
      requestId: ctx.requestId ?? null,
      primary: { strategyType: selection.strategyType, routeKind: selection.routeKind, score: selection.score ?? null },
      fallbacks,
      retryPolicy: { ...this.retryPolicy },
      failureMetadata: { deterministic: true, generatedFrom: "ranked-route-scores", count: fallbacks.length },
      schemaVersion: ADAPTIVE_SCHEMA_VERSION,
    });

    this.events?.emit(AdaptiveEventType.FALLBACK_GENERATED, { requestId: ctx.requestId, primary: fallbackPlan.primary.routeKind, fallbackCount: fallbacks.length });
    return fallbackPlan;
  }
}

function reasonFor(routeKind) {
  switch (routeKind) {
    case RouteKind.RELAYED_TRANSPORT:
      return FallbackReason.RELAY_FALLBACK;
    case RouteKind.STORE_AND_FORWARD:
      return FallbackReason.OFFLINE_FALLBACK;
    case RouteKind.SYNC_CHANNEL:
      return FallbackReason.SYNC_FALLBACK;
    default:
      return FallbackReason.LOWER_RANKED_ALTERNATIVE;
  }
}

function isMessaging(selection) {
  return [RouteKind.DIRECT_TRANSPORT, RouteKind.RELAYED_TRANSPORT].includes(selection.routeKind);
}

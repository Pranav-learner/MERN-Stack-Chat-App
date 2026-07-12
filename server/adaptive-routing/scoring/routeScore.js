/**
 * @module adaptive-routing/scoring/routeScore
 *
 * The **Route Score** model + substrate mapping. A route score is the frozen result of running every
 * scorer over one candidate: a normalized weighted `total`, a per-dimension `breakdown`, a `viable` flag,
 * and an ordered `reasons` audit. The `ROUTE_SUBSTRATE` table maps a {@link RouteKind} to the network
 * substrate whose availability governs it — the single source of truth shared by the candidate builder,
 * the transport-availability scorer, and diagnostics.
 *
 * @security A route score is numeric + classification metadata only. No content.
 */

import { RouteKind, NetworkSubstrate } from "../types/types.js";
import { deepFreeze } from "../_fabric.js";

/** Which network substrate's availability governs each route kind. */
export const ROUTE_SUBSTRATE = Object.freeze({
  [RouteKind.DIRECT_TRANSPORT]: NetworkSubstrate.P2P,
  [RouteKind.RELAYED_TRANSPORT]: NetworkSubstrate.RELAY,
  [RouteKind.STORE_AND_FORWARD]: NetworkSubstrate.TRANSPORT,
  [RouteKind.MEDIA_PIPELINE]: NetworkSubstrate.TRANSPORT,
  [RouteKind.GROUP_FANOUT]: NetworkSubstrate.TRANSPORT,
  [RouteKind.SYNC_CHANNEL]: NetworkSubstrate.SYNC,
  [RouteKind.LOCAL]: NetworkSubstrate.CONNECTION,
});

/**
 * Build a frozen route score.
 * @param {object} spec
 * @param {string} spec.routeKind @param {string} spec.strategyType @param {number} spec.total
 * @param {boolean} spec.viable @param {Object<string, number>} spec.breakdown @param {object[]} spec.reasons
 * @param {number} [spec.rank]
 * @returns {import("../types/types.js").RouteScore}
 */
export function createRouteScore(spec) {
  return deepFreeze({
    routeKind: spec.routeKind,
    strategyType: spec.strategyType,
    total: round4(spec.total),
    viable: spec.viable,
    breakdown: spec.breakdown ?? {},
    reasons: spec.reasons ?? [],
    rank: spec.rank ?? -1,
    adaptive: spec.adaptive ?? false,
  });
}

function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

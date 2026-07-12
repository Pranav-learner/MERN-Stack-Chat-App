/**
 * @module adaptive-routing/scoring/scorers
 *
 * The **pluggable scorers** (STEP 6). Each scorer evaluates ONE {@link ScoreDimension} of a candidate route
 * and returns a normalized `[0,1]` sub-score (optionally a `hardFail` that vetoes the candidate outright,
 * plus a human-readable `note` for the explanation). The scoring engine folds them with configurable
 * weights. This is the seam that removes hardcoded transport conditionals: "should this be direct /
 * relayed / offline / streamed?" is answered by weighted scores, not `if` statements.
 *
 * A scorer:
 *   { dimension, describe, score(candidate, bundle) => { score, hardFail?, note? } }
 * where `bundle = { context, analysis, network, capabilities, policyResult, config }`.
 *
 * @evolution The three FUTURE dimensions (network quality / latency / bandwidth) ship as inert scorers
 * (weight 0, neutral 0.5) so Sprint 3 activates them by supplying a real network provider + weights.
 *
 * @security Scorers read control-plane analysis + declared capability + injected availability only.
 */

import { ScoreDimension, RouteKind, StrategyType, MediaType, CapabilityFeature, TransportCapability, Availability, PayloadClass } from "../types/types.js";
import { ROUTE_SUBSTRATE } from "./routeScore.js";
import { supportsTransport, hasFeature, supportsMedia } from "../capability/capabilityProfile.js";

const ROUTE_TO_TRANSPORT_CAP = Object.freeze({
  [RouteKind.DIRECT_TRANSPORT]: TransportCapability.DIRECT,
  [RouteKind.RELAYED_TRANSPORT]: TransportCapability.RELAY,
  [RouteKind.STORE_AND_FORWARD]: TransportCapability.STORE_AND_FORWARD,
  [RouteKind.MEDIA_PIPELINE]: TransportCapability.MEDIA_PIPELINE,
  [RouteKind.GROUP_FANOUT]: TransportCapability.GROUP_FANOUT,
  [RouteKind.SYNC_CHANNEL]: TransportCapability.SYNC_CHANNEL,
});

/** 1) Transport availability — is the route's network substrate reachable? Unavailable ⇒ hard veto. */
export const transportAvailabilityScorer = {
  dimension: ScoreDimension.TRANSPORT_AVAILABILITY,
  describe: "Scores whether the route's network substrate is available.",
  score(candidate, { network }) {
    const substrate = ROUTE_SUBSTRATE[candidate.routeKind];
    const state = network?.availability?.[substrate];
    if (state === Availability.UNAVAILABLE) return { score: 0, hardFail: true, note: `${substrate} unavailable` };
    if (state === Availability.UNKNOWN) return { score: 0.6, note: `${substrate} availability unknown` };
    return { score: 1, note: `${substrate} available` };
  },
};

/** 2) Security — all routes are E2E, but a direct hop is marginally preferable to an added relay hop. */
export const securityScorer = {
  dimension: ScoreDimension.SECURITY,
  describe: "Scores the security posture of the route.",
  score(candidate, { capabilities }) {
    if (!hasFeature(capabilities, CapabilityFeature.E2E_ENCRYPTION)) return { score: 0.4, note: "no negotiated E2E feature" };
    const byRoute = {
      [RouteKind.DIRECT_TRANSPORT]: 1,
      [RouteKind.SYNC_CHANNEL]: 1,
      [RouteKind.STORE_AND_FORWARD]: 0.9,
      [RouteKind.MEDIA_PIPELINE]: 0.9,
      [RouteKind.GROUP_FANOUT]: 0.9,
      [RouteKind.RELAYED_TRANSPORT]: 0.8, // extra relay hop (still E2E; server is a blind relay)
    };
    return { score: byRoute[candidate.routeKind] ?? 0.85, note: "E2E throughout" };
  },
};

/** 3) Capability match — does the negotiated profile support this route's transport (+ media/feature)? */
export const capabilityMatchScorer = {
  dimension: ScoreDimension.CAPABILITY_MATCH,
  describe: "Scores whether negotiated capabilities support the route.",
  score(candidate, { capabilities, analysis }) {
    const cap = ROUTE_TO_TRANSPORT_CAP[candidate.routeKind];
    if (cap && !supportsTransport(capabilities, cap)) return { score: 0, hardFail: true, note: `transport ${cap} not negotiated` };
    if (candidate.routeKind === RouteKind.MEDIA_PIPELINE && analysis.isMedia && !supportsMedia(capabilities, analysis.mediaType)) {
      return { score: 0, hardFail: true, note: `media ${analysis.mediaType} not supported` };
    }
    if (candidate.strategyType === StrategyType.GROUP && !hasFeature(capabilities, CapabilityFeature.GROUP_FANOUT)) return { score: 0.5, note: "group-fanout feature not advertised" };
    return { score: 1, note: "capabilities match" };
  },
};

/** 4) Policy match — folds the extended policy engine's per-strategy bias; a policy veto is a hard fail. */
export const policyMatchScorer = {
  dimension: ScoreDimension.POLICY_MATCH,
  describe: "Scores the route against evaluated communication policies.",
  score(candidate, { policyResult }) {
    if (!policyResult) return { score: 0.5, note: "no policy result" };
    if (policyResult.vetoRoutes?.includes(candidate.routeKind)) return { score: 0, hardFail: true, note: `route vetoed by policy` };
    if (policyResult.vetoStrategies?.includes(candidate.strategyType)) return { score: 0, hardFail: true, note: `strategy vetoed by policy` };
    const bias = policyResult.bias?.[candidate.strategyType] ?? 0;
    // map an additive bias (roughly [-3,3]) onto [0,1] around a 0.5 neutral
    const score = clamp01(0.5 + bias / 6);
    return { score, note: bias === 0 ? "policy neutral" : `policy bias ${bias > 0 ? "+" : ""}${bias}` };
  },
};

/** 5) Cost — relative communication cost (lower cost ⇒ higher score). Direct is cheapest. */
export const costScorer = {
  dimension: ScoreDimension.COST,
  describe: "Scores the relative communication cost of the route (cheaper is better).",
  score(candidate, { analysis }) {
    const base = {
      [RouteKind.DIRECT_TRANSPORT]: 1,
      [RouteKind.SYNC_CHANNEL]: 0.9,
      [RouteKind.STORE_AND_FORWARD]: 0.75, // durable queue + later delivery
      [RouteKind.GROUP_FANOUT]: 0.7, // N deliveries
      [RouteKind.MEDIA_PIPELINE]: 0.7, // blob movement
      [RouteKind.RELAYED_TRANSPORT]: 0.6, // extra hop + relay resource
    };
    let score = base[candidate.routeKind] ?? 0.7;
    // large payloads make relayed/direct text paths relatively costlier; media pipeline is designed for them
    if (analysis.payloadClass === PayloadClass.LARGE && candidate.routeKind !== RouteKind.MEDIA_PIPELINE) score *= 0.85;
    return { score: clamp01(score), note: `cost tier for ${candidate.routeKind}` };
  },
};

/** 6) Sync needs — a diverged replica boosts sync-carrying routes; otherwise neutral. */
export const syncNeedsScorer = {
  dimension: ScoreDimension.SYNC_NEEDS,
  describe: "Scores how well the route serves the synchronization need.",
  score(candidate, { analysis }) {
    if (!analysis.needsSync) {
      // pure sync routes for a non-diverged, non-self comm are slightly less apt
      return { score: candidate.routeKind === RouteKind.SYNC_CHANNEL && !analysis.isSelf ? 0.4 : 0.6, note: "no sync need" };
    }
    const boost = candidate.routeKind === RouteKind.SYNC_CHANNEL || candidate.strategyType === StrategyType.SYNCHRONIZATION ? 1 : 0.7;
    return { score: boost, note: "replica diverged" };
  },
};

// === future (Sprint 3) — inert placeholder scorers (weight 0) ================

/** Placeholder — Sprint 3 fills network quality from a real provider. */
export const networkQualityScorer = makePlaceholder(ScoreDimension.NETWORK_QUALITY);
/** Placeholder — Sprint 3 fills latency. */
export const latencyScorer = makePlaceholder(ScoreDimension.LATENCY);
/** Placeholder — Sprint 3 fills bandwidth. */
export const bandwidthScorer = makePlaceholder(ScoreDimension.BANDWIDTH);

function makePlaceholder(dimension) {
  return { dimension, describe: `Placeholder for ${dimension} (Sprint 3).`, score: () => ({ score: 0.5, note: "placeholder (Sprint 3)" }) };
}

/** The default, ordered scorer set (active dimensions + inert future placeholders). */
export const DEFAULT_SCORERS = Object.freeze([
  transportAvailabilityScorer,
  securityScorer,
  capabilityMatchScorer,
  policyMatchScorer,
  costScorer,
  syncNeedsScorer,
  networkQualityScorer,
  latencyScorer,
  bandwidthScorer,
]);

function clamp01(n) {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

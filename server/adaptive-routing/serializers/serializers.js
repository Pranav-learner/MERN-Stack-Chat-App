/**
 * @module adaptive-routing/serializers
 *
 * Serializers turning the adaptive engine's internal artifacts into stable, client-facing views. The
 * engine + API return these (never the raw internals), so the wire shape is decoupled and every view is
 * control-plane only.
 *
 * @security Views expose ids + classifications + scores + notes. No content.
 */

/** Capability profile view. */
export function toCapabilityView(profile) {
  if (!profile) return null;
  return {
    identityId: profile.identityId,
    deviceId: profile.deviceId,
    appVersion: profile.appVersion,
    protocolVersion: profile.protocolVersion,
    transports: profile.transports,
    media: profile.media,
    features: profile.features,
    codecs: profile.codecs,
    fingerprint: profile.fingerprint,
  };
}

/** Communication analysis view. */
export function toAnalysisView(analysis) {
  if (!analysis) return null;
  const { executionContext, ...rest } = analysis;
  return { ...rest, attempt: executionContext?.attempt ?? 1 };
}

/** Network analysis view. */
export function toNetworkView(network) {
  if (!network) return null;
  return { availability: network.availability, quality: network.quality, latencyMs: network.latencyMs, bandwidthKbps: network.bandwidthKbps, stability: network.stability, probed: network.probed };
}

/** A single route score view. */
export function toRouteScoreView(score) {
  if (!score) return null;
  return { strategy: score.strategyType, route: score.routeKind, total: score.total, viable: score.viable, rank: score.rank, breakdown: score.breakdown, adaptive: score.adaptive };
}

/** Ranked routes view. */
export function toRankingView(ranked) {
  return (ranked ?? []).map(toRouteScoreView);
}

/** Fallback plan view. */
export function toFallbackView(fallbackPlan) {
  if (!fallbackPlan) return null;
  return { primary: fallbackPlan.primary, fallbacks: fallbackPlan.fallbacks, retryPolicy: fallbackPlan.retryPolicy, failureMetadata: fallbackPlan.failureMetadata };
}

/** The full adaptive evaluation view (the API's primary payload). */
export function toEvaluationView(evaluation) {
  if (!evaluation) return null;
  return {
    requestId: evaluation.requestId,
    capability: toCapabilityView(evaluation.capabilities),
    analysis: toAnalysisView(evaluation.analysis),
    network: toNetworkView(evaluation.network),
    ranking: toRankingView(evaluation.ranked),
    selection: evaluation.selection,
    fallbackPlan: toFallbackView(evaluation.fallbackPlan),
    executionPlan: evaluation.executionPlan ?? null,
    explanation: evaluation.explanation,
    policyRefs: evaluation.policyResult?.policyRefs ?? [],
  };
}

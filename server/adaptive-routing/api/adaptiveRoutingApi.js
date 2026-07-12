/**
 * @module adaptive-routing/api
 *
 * The stable **Adaptive Routing service facade** the HTTP controller delegates to (STEP 11). Wraps the
 * {@link AdaptiveRoutingEngine} with a flat surface: evaluate a communication (the full intelligent
 * decision), get the best route, get a capability profile, get route scores, get a decision explanation,
 * get a fallback plan, and read diagnostics + health. This is the boundary the controller programs
 * against — never the engine internals.
 *
 * @security Every method returns a control-plane view (ids + classifications + scores). Evaluation +
 * best-route authorize the caller as the sender in the engine.
 */

export function createAdaptiveRoutingApi(engine) {
  return {
    /** Full intelligent evaluation → capability + analysis + network + ranking + selection + fallback + plan + explanation. */
    evaluate: (input, opts) => engine.evaluate(input, opts),
    /** Best route only (dry run). */
    getBestRoute: (input, opts) => engine.getBestRoute(input, opts),
    /** Negotiated capability profile for a communication. */
    getCapabilityProfile: (params) => engine.getCapabilityProfile(params),
    /** Ranked route scores (dry run). */
    getRouteScores: (input, opts) => engine.getRouteScores(input, opts),
    /** Decision explanation (dry run). */
    getDecisionExplanation: (input, opts) => engine.getDecisionExplanation(input, opts),
    /** Fallback plan (dry run). */
    getFallbackPlan: (input, opts) => engine.getFallbackPlan(input, opts),
    /** Diagnostics + audit trail for a request. */
    diagnostics: ({ requestId }) => engine.diagnostics(requestId),
    /** Adaptive health. */
    health: () => engine.health(),
  };
}

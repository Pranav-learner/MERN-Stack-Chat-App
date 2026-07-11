/**
 * @module endpoint-selection
 *
 * Public entry point of the **Endpoint Selection & Connection Planning** subsystem — Layer 6,
 * Sprint 5. A user may have several devices connected at once; this subsystem picks the OPTIMAL
 * endpoint(s) and produces a resilient, failover-ready {@link EndpointConnectionPlan}:
 *
 * ```
 * candidates → score (multi-dimensional, extensible) → rank → primary + fallbacks → Connection Plan
 * ```
 *
 * ## Out of scope for Sprint 5 (Layer 7)
 * NO NAT Traversal, NO ICE/STUN/TURN, NO WebRTC, NO direct peer connections, NO socket creation.
 * This subsystem selects endpoints + prepares plans with failover; it establishes NOTHING. The
 * plan's `nat` block is the inert extension point Layer 7 fills.
 *
 * @security Everything here is PUBLIC control-plane metadata — device ids, public identities,
 * presence status, negotiated capabilities, scores. The subsystem NEVER touches a private key,
 * session key, message key, chain key, or shared secret; the {@link module:endpoint-selection/validators}
 * no-secret invariant is enforced before a plan is stored or returned.
 *
 * @example
 * ```js
 * import { EndpointSelectionManager, createInMemoryEndpointRepository, createEndpointApi } from "./endpoint-selection/index.js";
 * const mgr = new EndpointSelectionManager({ ...createInMemoryEndpointRepository() });
 * const { plan } = await mgr.generateConnectionPlan({ requester: "u1", requesterDevice: "d1", targetUser: "u2", candidates });
 * ```
 */

// Manager + API facade
export { EndpointSelectionManager } from "./manager/endpointSelectionManager.js";
export { createEndpointApi } from "./api/endpointApi.js";

// Scoring engine
export { scoreEndpoint, rankEndpoints, inferDeviceType, isReachable, DIMENSION_FUNCTIONS } from "./scorer/scoring.js";

// Policies
export { POLICY_PROFILES, resolvePolicy, isKnownPolicy } from "./policies/policies.js";

// Routing + planner + failover
export { buildRoutingDecision, toEndpoint, describeSelection, rerouteFirst } from "./routing/routing.js";
export { createEndpointConnectionPlan, isPlanExpired, planCacheKey, createNatPlaceholder } from "./planner/connectionPlan.js";
export { applyFailover, markExhausted, refreshRouting } from "./failover/failover.js";

// Cache
export { EndpointCache, EndpointCacheOutcome } from "./cache/cache.js";

// Repositories
export { createInMemoryEndpointRepository } from "./repository/inMemoryEndpointRepository.js";
export { createMongoEndpointRepository } from "./repository/mongoEndpointRepository.js";

// Events
export { EndpointEventBus } from "./events/events.js";

// Validation
export {
  validatePlanId,
  validateUserRef,
  validateDeviceRef,
  validatePolicy,
  validateCandidates,
  validateGenerateRequest,
  requirePlan,
  assertPlanNotExpired,
  assertRequester,
  assertNoSecretMaterial,
  validateConnectionPlan,
  validatePlanRepository,
  validateReliabilityRepository,
  FORBIDDEN_SECRET_KEYS,
} from "./validators/validators.js";

// Serialization
export {
  toPublicPlan,
  toPublicEndpoint,
  toPublicRanked,
  toPlanStatus,
  toPlanListItem,
} from "./serializers/serializer.js";

// Errors + types
export * from "./errors.js";
export {
  SelectionPolicy,
  ALL_SELECTION_POLICIES,
  ScoringDimension,
  ALL_SCORING_DIMENSIONS,
  FUTURE_DIMENSIONS,
  DeviceType,
  PlanStatus,
  OutcomeType,
  EndpointEventType,
  EndpointFailureReason,
  EndpointSource,
  ES_SCHEMA_VERSION,
  ES_FRAMEWORK,
  DEFAULT_PLAN_TTL_MS,
  DEFAULT_MAX_FALLBACKS,
  DEFAULT_RETRY_MAX_ATTEMPTS,
  DEFAULT_RETRY_BACKOFF_MS,
  DEFAULT_ES_CACHE_TTL_MS,
  DEFAULT_ES_CACHE_LIMIT,
} from "./types/types.js";

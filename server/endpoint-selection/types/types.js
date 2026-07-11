/**
 * @module endpoint-selection/types
 *
 * Enums and type declarations for the **Endpoint Selection & Connection Planning** subsystem —
 * Layer 6, Sprint 5. A user may have several devices connected at once; this subsystem decides the
 * OPTIMAL endpoint(s) to communicate with and produces a resilient, failover-ready
 * {@link EndpointConnectionPlan}.
 *
 * ```
 * candidate devices  →  score (multi-dimensional)  →  rank  →  primary + fallbacks  →  Connection Plan
 * ```
 *
 * @security This subsystem consumes + emits PUBLIC control-plane data — device ids, public
 * identities, presence status, negotiated capabilities, scores. It NEVER exposes private keys,
 * session keys, message keys, chain keys, or shared secrets. See {@link module:endpoint-selection/validators}
 * for the enforced no-secret invariant.
 *
 * @evolution Transport-INDEPENDENT: it selects endpoints + prepares a plan; it does NOT establish
 * connections, do NAT traversal, or run ICE/STUN/TURN/WebRTC. A FUTURE Layer 7 consumes the plan
 * (its `nat` block is the inert extension point). Scoring is EXTENSIBLE — new dimensions (network
 * quality, NAT type, …) plug in without changing callers.
 */

/**
 * Configurable selection policies. A policy is a named scoring-weight profile (+ optional filter /
 * device-type preference). All are deterministic: ties break by `deviceId` ascending.
 * @readonly @enum {string}
 */
export const SelectionPolicy = Object.freeze({
  HIGHEST_SCORE: "highest-score", // pure weighted multi-dimensional score (default)
  MOST_RECENTLY_ACTIVE: "most-recently-active", // weight recency heavily
  PREFERRED_PLATFORM: "preferred-platform", // prefer a requested platform
  LOWEST_LATENCY: "lowest-latency", // FUTURE — latency is a placeholder (neutral); deterministic tie-break
  BATTERY_FRIENDLY: "battery-friendly", // prefer likely-plugged-in (desktop) endpoints
  DESKTOP_PREFERRED: "desktop-preferred", // prefer desktop device type
  MOBILE_PREFERRED: "mobile-preferred", // prefer mobile device type
  MANUAL_PREFERENCE: "manual-preference", // pin a specific requested deviceId
  CUSTOM: "custom", // caller-supplied weights / dimensions
});

/** All built-in selection policies. */
export const ALL_SELECTION_POLICIES = Object.freeze(Object.values(SelectionPolicy));

/**
 * The scoring dimensions. Each contributes a value in `[0,1]`; a policy assigns each a weight and
 * the engine returns the weighted average. `NETWORK_QUALITY` + `NAT_TYPE` are FUTURE placeholders
 * (inert/neutral today) — the extension points a later sprint fills.
 * @readonly @enum {string}
 */
export const ScoringDimension = Object.freeze({
  PRESENCE: "presence",
  CAPABILITY: "capability",
  PROTOCOL: "protocol",
  SECURITY: "security",
  PLATFORM: "platform",
  USER_PREFERENCE: "userPreference",
  RELIABILITY: "reliability", // historical success/failure ratio
  PRIORITY: "priority", // declared device priority
  RECENCY: "recency", // how recently the device was active
  DEVICE_TYPE: "deviceType", // matches a preferred device type (desktop/mobile)
  NETWORK_QUALITY: "networkQuality", // FUTURE — inert (neutral)
  NAT_TYPE: "natType", // FUTURE — inert (neutral)
});

/** All scoring dimensions. */
export const ALL_SCORING_DIMENSIONS = Object.freeze(Object.values(ScoringDimension));

/** Dimensions that are FUTURE placeholders (inert / neutral). */
export const FUTURE_DIMENSIONS = Object.freeze([ScoringDimension.NETWORK_QUALITY, ScoringDimension.NAT_TYPE]);

/** A device's inferred form factor (used by battery/desktop/mobile policies). */
export const DeviceType = Object.freeze({
  DESKTOP: "desktop",
  MOBILE: "mobile",
  UNKNOWN: "unknown",
});

/** Connection-plan status. */
export const PlanStatus = Object.freeze({
  ACTIVE: "active", // primary is the chosen endpoint
  FAILED_OVER: "failed-over", // primary failed; a fallback was promoted
  EXPIRED: "expired", // outlived its TTL
  EXHAUSTED: "exhausted", // primary + all fallbacks failed
  SUPERSEDED: "superseded", // replaced by a refreshed plan
});

/** Outcome of attempting to use an endpoint (feeds historical reliability). */
export const OutcomeType = Object.freeze({ SUCCESS: "success", FAILURE: "failure" });

/**
 * Endpoint-selection event types. Future Layer 7 (NAT Traversal) subscribes to these.
 * @readonly @enum {string}
 */
export const EndpointEventType = Object.freeze({
  ENDPOINT_RANKED: "endpoint.ranked",
  PRIMARY_ENDPOINT_SELECTED: "endpoint.primary_selected",
  FALLBACK_GENERATED: "endpoint.fallback_generated",
  ROUTING_UPDATED: "endpoint.routing_updated",
  SELECTION_POLICY_APPLIED: "endpoint.policy_applied",
  CONNECTION_PLAN_CREATED: "endpoint.plan_created",
  CONNECTION_PLAN_UPDATED: "endpoint.plan_updated",
  SELECTION_FAILED: "endpoint.selection_failed",
  OUTCOME_RECORDED: "endpoint.outcome_recorded",
  CACHE_INVALIDATED: "endpoint.cache_invalidated",
});

/**
 * Machine-readable reasons attached to selection failures + validation results.
 * @readonly @enum {string}
 */
export const EndpointFailureReason = Object.freeze({
  NO_CANDIDATES: "no-candidates",
  NO_REACHABLE_ENDPOINT: "no-reachable-endpoint",
  NO_COMPATIBLE_ENDPOINT: "no-compatible-endpoint",
  ALL_FILTERED: "all-filtered-out",
  OFFLINE_PRIMARY: "offline-primary",
  MISSING_FALLBACK: "missing-fallback",
  CAPABILITY_MISMATCH: "capability-mismatch",
  SELECTION_CONFLICT: "selection-conflict",
  DUPLICATE_ENDPOINT: "duplicate-endpoint",
  INVALID_RANKING: "invalid-ranking",
  MALFORMED_METADATA: "malformed-metadata",
  EXPIRED_PLAN: "expired-plan",
  UNAUTHORIZED: "unauthorized",
  INTERNAL_ERROR: "internal-error",
});

/** How a plan/ranking was sourced (observability). */
export const EndpointSource = Object.freeze({ CACHE: "cache", COMPUTED: "computed" });

/** Current endpoint-selection record storage schema version. */
export const ES_SCHEMA_VERSION = 1;

/** The subsystem identifier stamped onto plans + selections. */
export const ES_FRAMEWORK = "endpoint-selection";

/** Default connection-plan TTL (ms) — a plan is a short-lived snapshot Layer 7 must act on soon. */
export const DEFAULT_PLAN_TTL_MS = 60_000;

/** Default maximum fallback endpoints a plan carries (beyond the primary). */
export const DEFAULT_MAX_FALLBACKS = 3;

/** Default retry-strategy attempt count (per endpoint) Layer 7 should try. */
export const DEFAULT_RETRY_MAX_ATTEMPTS = 3;

/** Default retry backoff (ms) between attempts (advisory to Layer 7). */
export const DEFAULT_RETRY_BACKOFF_MS = 500;

/** Default endpoint-cache TTL (ms). Bounded by the plan TTL. */
export const DEFAULT_ES_CACHE_TTL_MS = 15_000;

/** Default endpoint-cache capacity before LRU eviction. */
export const DEFAULT_ES_CACHE_LIMIT = 5_000;

/**
 * @typedef {object} EndpointCandidate An input device to evaluate. Matches the PDP `SelectedDevice`
 *   / candidate shape so a PDP workflow can feed this subsystem directly.
 * @property {string} deviceId @property {string|null} [identityId]
 * @property {object|null} [publicIdentity] the device's PUBLIC identity descriptor
 * @property {string} presenceStatus one of the presence statuses
 * @property {string|null} [lastSeen] ISO timestamp
 * @property {string} [platform] @property {string} [deviceType] one of {@link DeviceType} (inferred if absent)
 * @property {string} [softwareVersion]
 * @property {object} capabilities the negotiation RESULT for (requesterDevice ↔ this device)
 * @property {number} [priority] declared device priority
 * @property {object} [metadata]
 */

/**
 * @typedef {object} ScoredEndpoint A candidate after scoring + ranking.
 * @property {string} deviceId @property {number} score total weighted score `[0,1]`
 * @property {number} rank 0-based rank (0 = best) @property {Record<string, number>} breakdown per-dimension values
 * @property {boolean} eligible whether it passed hard filters (reachable + compatible)
 * @property {string} [ineligibleReason] why it was filtered (if not eligible)
 * @property {object} candidate the original candidate (PUBLIC fields)
 */

/**
 * @typedef {object} EndpointConnectionPlan The OPTIMIZED, failover-ready connection plan — the
 *   subsystem's primary output. Extends the PDP connection-plan idea with a ranked primary +
 *   fallback endpoints, a selection reason, a retry strategy, and a per-dimension score breakdown.
 * @property {string} planId @property {string} requester @property {string} requesterDevice
 * @property {string} targetUser @property {string} status one of {@link PlanStatus}
 * @property {object} primaryEndpoint the selected primary (deviceId + capabilities + score + reason)
 * @property {object[]} fallbackEndpoints ranked backups
 * @property {string[]} priorityOrder deviceIds in descending preference (primary first)
 * @property {string} selectionReason human-readable why-this-primary
 * @property {object} negotiatedCapabilities the primary's negotiated capabilities
 * @property {string|null} preferredTransport @property {string[]} fallbackTransports
 * @property {object} retryStrategy `{ maxAttempts, backoffMs, order: deviceId[] }`
 * @property {string} selectionPolicy @property {Record<string, number>} weights the applied weights
 * @property {object} nat FUTURE placeholder — inert NAT-metadata block (Layer 7)
 * @property {number} priority @property {number} generation refresh/failover counter
 * @property {string} createdAt @property {string} updatedAt @property {string} expiresAt
 * @property {object} metadata @property {number} schemaVersion
 */

/**
 * @typedef {object} ReliabilityRecord Per-(user,device) historical reliability, feeding the
 *   RELIABILITY scoring dimension.
 * @property {string} targetUser @property {string} deviceId
 * @property {number} successes @property {number} failures @property {string|null} lastOutcome
 * @property {string|null} lastOutcomeAt @property {number} reliability Laplace-smoothed `[0,1]`
 */

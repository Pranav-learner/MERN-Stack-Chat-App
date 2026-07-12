/**
 * @module adaptive-routing/types
 *
 * Enums + constants for **Layer 12 · Sprint 2 — Intelligent Routing & Adaptive Communication.** This is an
 * INDEPENDENT subsystem built ON TOP of the frozen Sprint-1 Communication Fabric: it turns the Fabric's
 * deterministic decision into an ADAPTIVE one by collecting capability profiles, analyzing the
 * communication + network posture, scoring candidate routes with pluggable scorers, selecting the optimal
 * strategy, and producing explainable execution + fallback plans — all WITHOUT hardcoded transport
 * conditionals and WITHOUT touching the Sprint-1 pipeline.
 *
 * It REUSES the frozen Sprint-1 vocabulary (`CommunicationType`, `ConversationType`, `MediaType`,
 * `Priority`, `StrategyType`, `RouteKind`, `SubsystemKind`) via `communication-fabric` — this sprint adds
 * only the ADAPTIVE vocabulary (score dimensions, weights, capability features, network availability,
 * fallback reasons, events).
 *
 * @security The adaptive layer reasons over communication CONTROL-PLANE metadata + declared capability +
 * (injected) network AVAILABILITY only — never message plaintext, ciphertext, or key material. No route is
 * ever bound to a concrete transport socket here; the layer ranks abstract {@link RouteKind}s.
 *
 * @performance Every vocabulary is a frozen table; scoring is O(candidates × scorers) of constant-time
 * weighted sums, and the whole evaluation is pure + synchronous (no I/O, no probing), so decisions are
 * cache-friendly and safe under concurrency.
 *
 * @evolution The score-dimension table declares FUTURE dimensions (network quality, latency, bandwidth) as
 * inert placeholders so Sprint 3 (resource optimization) activates them by supplying weights + a real
 * network provider — no structural change. Runtime probing / ML are explicitly out of scope this sprint.
 */

// Re-export the frozen Sprint-1 vocabulary this layer consumes, so downstream adaptive code has one import.
export { CommunicationType, ConversationType, MediaType, Priority, StrategyType, RouteKind, SubsystemKind, PRIORITY_RANK } from "../../communication-fabric/index.js";

// === capability ============================================================

/**
 * Transport capabilities a party can declare it supports. These map 1:1 onto Sprint-1 {@link RouteKind}s
 * so capability filtering + route scoring speak the same language.
 * @readonly @enum {string}
 */
export const TransportCapability = Object.freeze({
  DIRECT: "direct-transport",
  RELAY: "relayed-transport",
  STORE_AND_FORWARD: "store-and-forward",
  MEDIA_PIPELINE: "media-pipeline",
  GROUP_FANOUT: "group-fanout",
  SYNC_CHANNEL: "sync-channel",
});

export const ALL_TRANSPORT_CAPABILITIES = Object.freeze(Object.values(TransportCapability));

/**
 * Feature flags a party may advertise. Drive capability-match scoring + policy hooks. Extensible — a
 * deployment may declare additional flags; unknown flags are ignored, not rejected.
 * @readonly @enum {string}
 */
export const CapabilityFeature = Object.freeze({
  E2E_ENCRYPTION: "e2e-encryption",
  FORWARD_SECRECY: "forward-secrecy",
  GROUP_FANOUT: "group-fanout",
  MEDIA_STREAMING: "media-streaming",
  PROGRESSIVE_MEDIA: "progressive-media",
  OFFLINE_QUEUE: "offline-queue",
  MULTI_DEVICE_SYNC: "multi-device-sync",
  RECEIPTS: "receipts",
});

export const ALL_CAPABILITY_FEATURES = Object.freeze(Object.values(CapabilityFeature));

/** The minimum protocol version the adaptive layer understands (capability floor). */
export const MIN_PROTOCOL_VERSION = 1;
/** The protocol version this sprint negotiates to. */
export const CURRENT_PROTOCOL_VERSION = 1;

// === network availability ==================================================

/**
 * Availability of a communication substrate. Sprint 2 uses AVAILABILITY only (a boolean-ish tri-state);
 * runtime QUALITY (latency/bandwidth/stability) is declared below as placeholders and stays `null` — NO
 * probing this sprint.
 * @readonly @enum {string}
 */
export const Availability = Object.freeze({
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
  UNKNOWN: "unknown", // provider not wired → treated conservatively
});

export const ALL_AVAILABILITIES = Object.freeze(Object.values(Availability));

/** The network substrates whose availability the {@link NetworkAnalyzer} reports. */
export const NetworkSubstrate = Object.freeze({
  CONNECTION: "connection",
  TRANSPORT: "transport",
  P2P: "p2p",
  RELAY: "relay",
  SYNC: "sync",
});

export const ALL_NETWORK_SUBSTRATES = Object.freeze(Object.values(NetworkSubstrate));

// === scoring ===============================================================

/**
 * The dimensions a route is scored on. The first six are ACTIVE in Sprint 2; the last three are declared
 * placeholders (weight 0, neutral contribution) that Sprint 3 activates with a real network provider.
 * @readonly @enum {string}
 */
export const ScoreDimension = Object.freeze({
  TRANSPORT_AVAILABILITY: "transport-availability",
  SECURITY: "security",
  CAPABILITY_MATCH: "capability-match",
  POLICY_MATCH: "policy-match",
  COST: "cost",
  SYNC_NEEDS: "sync-needs",
  // --- future (Sprint 3) — inert placeholders ---
  NETWORK_QUALITY: "network-quality",
  LATENCY: "latency",
  BANDWIDTH: "bandwidth",
});

export const ALL_SCORE_DIMENSIONS = Object.freeze(Object.values(ScoreDimension));

/** The dimensions that actively contribute in Sprint 2. */
export const ACTIVE_SCORE_DIMENSIONS = Object.freeze([
  ScoreDimension.TRANSPORT_AVAILABILITY,
  ScoreDimension.SECURITY,
  ScoreDimension.CAPABILITY_MATCH,
  ScoreDimension.POLICY_MATCH,
  ScoreDimension.COST,
  ScoreDimension.SYNC_NEEDS,
]);

/** Placeholder dimensions — declared, weight 0, activated in Sprint 3. */
export const FUTURE_SCORE_DIMENSIONS = Object.freeze([ScoreDimension.NETWORK_QUALITY, ScoreDimension.LATENCY, ScoreDimension.BANDWIDTH]);

/**
 * Default, CONFIGURABLE scoring weights. A deployment overrides any subset; future dimensions default to 0
 * so they never move a Sprint-2 score. Each active scorer returns a normalized [0,1] sub-score; the total
 * is the weighted sum.
 */
export const DEFAULT_SCORE_WEIGHTS = Object.freeze({
  [ScoreDimension.TRANSPORT_AVAILABILITY]: 4,
  [ScoreDimension.SECURITY]: 3,
  [ScoreDimension.CAPABILITY_MATCH]: 3,
  [ScoreDimension.POLICY_MATCH]: 2,
  [ScoreDimension.COST]: 2,
  [ScoreDimension.SYNC_NEEDS]: 2,
  [ScoreDimension.NETWORK_QUALITY]: 0,
  [ScoreDimension.LATENCY]: 0,
  [ScoreDimension.BANDWIDTH]: 0,
});

/** A route scoring below this normalized total is treated as non-viable (filtered from selection). */
export const MIN_VIABLE_SCORE = 0.01;

// === fallback ==============================================================

/** Why a fallback route/strategy would be attempted. Recorded on each fallback entry (deterministic). */
export const FallbackReason = Object.freeze({
  PRIMARY_FAILED: "primary-failed",
  TRANSPORT_UNAVAILABLE: "transport-unavailable",
  CAPABILITY_MISMATCH: "capability-mismatch",
  POLICY_CONSTRAINT: "policy-constraint",
  LOWER_RANKED_ALTERNATIVE: "lower-ranked-alternative",
  RELAY_FALLBACK: "relay-fallback",
  SYNC_FALLBACK: "sync-fallback",
  OFFLINE_FALLBACK: "offline-fallback",
});

/** Default deterministic retry policy attached to a fallback plan (metadata only — no execution here). */
export const DEFAULT_RETRY_POLICY = Object.freeze({ maxAttempts: 3, backoff: "exponential", baseDelayMs: 500, maxDelayMs: 8_000 });

// === payload classification ================================================

/** Payload-size class thresholds (bytes) used by the communication analyzer. */
export const PAYLOAD_SIZE_CLASS = Object.freeze({ SMALL_MAX: 64 * 1024, MEDIUM_MAX: 4 * 1024 * 1024 });

/** @readonly @enum {string} */
export const PayloadClass = Object.freeze({ SMALL: "small", MEDIUM: "medium", LARGE: "large", NONE: "none" });

// === events ================================================================

/**
 * Internal adaptive-routing event types. **Sprint 3 (resource optimization / QoS) CONSUMES these** to
 * observe scoring + selection and drive global optimization WITHOUT modifying this pipeline. Events carry
 * ids + classifications + scores only — never content/keys.
 * @readonly @enum {string}
 */
export const AdaptiveEventType = Object.freeze({
  CAPABILITIES_COLLECTED: "adaptive.capabilities_collected",
  COMMUNICATION_ANALYZED: "adaptive.communication_analyzed",
  NETWORK_ANALYZED: "adaptive.network_analyzed",
  POLICIES_EVALUATED: "adaptive.policies_evaluated",
  ROUTES_SCORED: "adaptive.routes_scored",
  STRATEGY_SELECTED: "adaptive.strategy_selected",
  FALLBACK_GENERATED: "adaptive.fallback_generated",
  EXECUTION_PLANNED: "adaptive.execution_planned",
  DECISION_EXPLAINED: "adaptive.decision_explained",
});

export const ALL_ADAPTIVE_EVENT_TYPES = Object.freeze(Object.values(AdaptiveEventType));

// === failure reasons =======================================================

/** Machine-readable adaptive failure/validation reasons. */
export const AdaptiveFailureReason = Object.freeze({
  INVALID_CAPABILITIES: "invalid-capabilities",
  INVALID_ANALYSIS: "invalid-analysis",
  MISSING_ANALYSIS: "missing-analysis",
  NO_VIABLE_ROUTE: "no-viable-route",
  UNKNOWN_ROUTE: "unknown-route",
  POLICY_CONFLICT: "policy-conflict",
  STRATEGY_CONFLICT: "strategy-conflict",
  UNAUTHORIZED: "unauthorized",
  REPOSITORY_INCONSISTENT: "repository-inconsistent",
  CONFIGURATION_ERROR: "configuration-error",
  CONTENT_LEAK: "content-leak",
  INTERNAL_ERROR: "internal-error",
});

// === constants =============================================================

export const ADAPTIVE_FRAMEWORK = "adaptive-routing";
export const ADAPTIVE_SCHEMA_VERSION = 1;
export const ADAPTIVE_LAYER = 12;
export const ADAPTIVE_SPRINT = 2;

/** Evaluation cache TTL (ms) + max — identical (capability, analysis, network, policy) inputs reuse a ranking. */
export const DEFAULT_EVAL_CACHE_TTL_MS = 15_000;
export const DEFAULT_EVAL_CACHE_MAX = 5_000;

/** Capability-profile cache TTL (ms) + max. */
export const DEFAULT_CAPABILITY_CACHE_TTL_MS = 60_000;
export const DEFAULT_CAPABILITY_CACHE_MAX = 10_000;

/** Bounded audit-trail retention per evaluation. */
export const MAX_AUDIT_ENTRIES = 100;

/**
 * @typedef {object} CapabilityProfile An immutable, negotiated capability snapshot.
 * @property {string} identityId @property {string|null} deviceId
 * @property {number} appVersion @property {number} protocolVersion
 * @property {string[]} transports supported {@link TransportCapability}
 * @property {string[]} media supported {@link MediaType}
 * @property {string[]} features advertised {@link CapabilityFeature}
 * @property {string[]} codecs future codec ids (empty in Sprint 2)
 * @property {object} flags raw feature flags @property {string} fingerprint stable hash @property {string} collectedAt
 */

/**
 * @typedef {object} RouteScore A scored candidate route.
 * @property {string} routeKind one of {@link RouteKind} @property {string} strategyType one of {@link StrategyType}
 * @property {number} total normalized weighted total @property {boolean} viable
 * @property {Object<string, number>} breakdown per-{@link ScoreDimension} contribution
 * @property {object[]} reasons ordered scorer notes @property {number} rank 0 = best
 */

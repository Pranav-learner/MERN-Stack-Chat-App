/**
 * @module networking-hardening/types
 *
 * Enums + constants for the **Production Networking Hardening** subsystem — Layer 6, Sprint 6.
 * This subsystem does NOT add networking features; it makes the Layer 6 control plane (Discovery,
 * Presence, Capabilities, Peer Discovery Protocol, Endpoint Selection) PRODUCTION-READY by adding
 * cross-cutting recovery, distributed-consistency, security-validation, observability,
 * monitoring/alerting, rate-limiting, and repository-hardening — plus a protocol freeze.
 *
 * @security Everything here operates on METADATA + numeric aggregates only. Metrics, alerts, and
 * recovery contexts carry ids/counts/reasons — NEVER a private key, session key, message key,
 * chain key, or shared secret.
 *
 * @evolution Transport-INDEPENDENT. This sprint hardens the control plane and freezes its
 * interfaces so a FUTURE Layer 7 (NAT Traversal / ICE / WebRTC / relay / P2P) can build on stable
 * seams without an architectural redesign.
 */

/** Metric kinds the {@link module:networking-hardening/observability MetricsRegistry} tracks. */
export const MetricType = Object.freeze({ COUNTER: "counter", GAUGE: "gauge", HISTOGRAM: "histogram" });

/**
 * Canonical networking metric names (stable — treated as a frozen interface). Use these so
 * dashboards + alerts across deployments agree.
 * @readonly @enum {string}
 */
export const Metric = Object.freeze({
  DISCOVERY_LATENCY: "networking_discovery_latency_ms",
  DISCOVERY_TOTAL: "networking_discovery_total",
  DISCOVERY_SUCCESS: "networking_discovery_success_total",
  DISCOVERY_FAILURE: "networking_discovery_failure_total",
  PRESENCE_UPDATE: "networking_presence_update_total",
  HEARTBEAT_FAILURE: "networking_heartbeat_failure_total",
  NEGOTIATION_LATENCY: "networking_negotiation_latency_ms",
  NEGOTIATION_TOTAL: "networking_negotiation_total",
  PLAN_GENERATION_LATENCY: "networking_plan_generation_latency_ms",
  PLAN_GENERATED: "networking_plan_generated_total",
  ENDPOINT_SELECTION_LATENCY: "networking_endpoint_selection_latency_ms",
  CACHE_HIT: "networking_cache_hit_total",
  CACHE_MISS: "networking_cache_miss_total",
  CACHE_HIT_RATIO: "networking_cache_hit_ratio",
  REPOSITORY_LATENCY: "networking_repository_latency_ms",
  REPOSITORY_FAILURE: "networking_repository_failure_total",
  CONCURRENT_DISCOVERIES: "networking_concurrent_discoveries",
  RECOVERY_TOTAL: "networking_recovery_total",
  RATE_LIMITED_TOTAL: "networking_rate_limited_total",
  ALERT_TOTAL: "networking_alert_total",
  CIRCUIT_OPEN_TOTAL: "networking_circuit_open_total",
});

/**
 * Failure kinds the {@link module:networking-hardening/recovery RecoveryCoordinator} handles.
 * @readonly @enum {string}
 */
export const RecoveryKind = Object.freeze({
  INTERRUPTED_DISCOVERY: "interrupted-discovery",
  REPOSITORY_FAILURE: "repository-failure",
  PRESENCE_INCONSISTENCY: "presence-inconsistency",
  CAPABILITY_REFRESH_FAILURE: "capability-refresh-failure",
  ENDPOINT_SELECTION_FAILURE: "endpoint-selection-failure",
  EXPIRED_PLAN: "expired-plan",
  CACHE_CORRUPTION: "cache-corruption",
});

/**
 * Recovery actions a failure maps to.
 * @readonly @enum {string}
 */
export const RecoveryAction = Object.freeze({
  RETRY: "retry", // retry the operation (with backoff, bounded)
  REBUILD: "rebuild", // rebuild derived state (e.g. re-run a workflow / refresh a plan)
  INVALIDATE_CACHE: "invalidate-cache", // drop + rebuild the affected cache entry
  DEGRADE: "degrade", // graceful degradation (serve a reduced result)
  QUARANTINE: "quarantine", // isolate a corrupt record for later inspection
  ESCALATE: "escalate", // unrecoverable → raise an alert
});

/** Which recovery action + recoverability each failure kind defaults to. */
export const RECOVERY_PLANS = Object.freeze({
  [RecoveryKind.INTERRUPTED_DISCOVERY]: { action: RecoveryAction.RETRY, recoverable: true },
  [RecoveryKind.REPOSITORY_FAILURE]: { action: RecoveryAction.RETRY, recoverable: true },
  [RecoveryKind.PRESENCE_INCONSISTENCY]: { action: RecoveryAction.REBUILD, recoverable: true },
  [RecoveryKind.CAPABILITY_REFRESH_FAILURE]: { action: RecoveryAction.RETRY, recoverable: true },
  [RecoveryKind.ENDPOINT_SELECTION_FAILURE]: { action: RecoveryAction.DEGRADE, recoverable: true },
  [RecoveryKind.EXPIRED_PLAN]: { action: RecoveryAction.REBUILD, recoverable: true },
  [RecoveryKind.CACHE_CORRUPTION]: { action: RecoveryAction.INVALIDATE_CACHE, recoverable: true },
});

/**
 * Alert types the {@link module:networking-hardening/monitoring NetworkMonitor} raises.
 * @readonly @enum {string}
 */
export const AlertType = Object.freeze({
  DISCOVERY_FAILURE_SPIKE: "discovery-failure-spike",
  REPEATED_LOOKUP_FAILURE: "repeated-lookup-failure",
  PRESENCE_INSTABILITY: "presence-instability",
  CAPABILITY_MISMATCH_SPIKE: "capability-mismatch-spike",
  REPOSITORY_FAILURE: "repository-failure",
  CACHE_FAILURE: "cache-failure",
  ABNORMAL_ENDPOINT_CHURN: "abnormal-endpoint-churn",
  API_FAILURE_SPIKE: "api-failure-spike",
  RATE_LIMIT_ABUSE: "rate-limit-abuse",
  ENUMERATION_SUSPECTED: "enumeration-suspected",
});

/** Alert severities. @readonly @enum {string} */
export const AlertSeverity = Object.freeze({ INFO: "info", WARNING: "warning", CRITICAL: "critical" });

/** Overall health status of the networking control plane. @readonly @enum {string} */
export const HealthStatus = Object.freeze({ HEALTHY: "healthy", DEGRADED: "degraded", UNHEALTHY: "unhealthy" });

/** Circuit-breaker states (repository hardening). @readonly @enum {string} */
export const CircuitState = Object.freeze({ CLOSED: "closed", OPEN: "open", HALF_OPEN: "half-open" });

/**
 * Hardening event types (emitted on the {@link module:networking-hardening/events bus}). Future
 * Layer 7 + external monitoring consume these.
 * @readonly @enum {string}
 */
export const HardeningEventType = Object.freeze({
  RECOVERY_STARTED: "hardening.recovery_started",
  RECOVERY_COMPLETED: "hardening.recovery_completed",
  RECOVERY_FAILED: "hardening.recovery_failed",
  ALERT_RAISED: "hardening.alert_raised",
  CIRCUIT_OPENED: "hardening.circuit_opened",
  CIRCUIT_CLOSED: "hardening.circuit_closed",
  RATE_LIMITED: "hardening.rate_limited",
  CONFLICT_RESOLVED: "hardening.conflict_resolved",
  CONSISTENCY_VIOLATION: "hardening.consistency_violation",
  HEALTH_CHANGED: "hardening.health_changed",
});

/** The layer identifier + hardening schema version. */
export const HARDENING_FRAMEWORK = "networking-hardening";
export const HARDENING_SCHEMA_VERSION = 1;

/** The frozen networking control-plane version (bump = a breaking control-plane change). */
export const NETWORKING_CONTROL_PLANE_VERSION = "1.0";

/** Default sliding window (ms) the monitor accumulates signals over. */
export const DEFAULT_MONITOR_WINDOW_MS = 60_000;

/** Default alert thresholds per window, per {@link AlertType}. */
export const DEFAULT_ALERT_THRESHOLDS = Object.freeze({
  [AlertType.DISCOVERY_FAILURE_SPIKE]: 20,
  [AlertType.REPEATED_LOOKUP_FAILURE]: 5,
  [AlertType.PRESENCE_INSTABILITY]: 10,
  [AlertType.CAPABILITY_MISMATCH_SPIKE]: 15,
  [AlertType.REPOSITORY_FAILURE]: 3,
  [AlertType.CACHE_FAILURE]: 3,
  [AlertType.ABNORMAL_ENDPOINT_CHURN]: 10,
  [AlertType.API_FAILURE_SPIKE]: 25,
  [AlertType.RATE_LIMIT_ABUSE]: 50,
  [AlertType.ENUMERATION_SUSPECTED]: 30,
});

/** Default retry policy (bounded exponential backoff). */
export const DEFAULT_RETRY_POLICY = Object.freeze({ maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 1000, factor: 2, jitter: true });

/** Default circuit-breaker configuration for the resilient repository. */
export const DEFAULT_CIRCUIT_CONFIG = Object.freeze({ failureThreshold: 5, cooldownMs: 5_000, halfOpenMax: 1 });

/** Default token-bucket rate-limit configuration (per subject). */
export const DEFAULT_RATE_LIMIT = Object.freeze({ capacity: 60, refillPerSec: 30 });

/** Default idempotency-cache TTL (ms). */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 60_000;

/** Max pagination page size (API hardening). */
export const MAX_PAGE_SIZE = 200;

/** Default pagination page size. */
export const DEFAULT_PAGE_SIZE = 50;

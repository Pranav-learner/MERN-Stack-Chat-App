/**
 * @module fabric-reliability/types
 *
 * Enums + constants for **Layer 12 · Sprint 4 — Production Communication Fabric.** This is the final,
 * INDEPENDENT subsystem that makes the whole Communication Fabric production-grade: reliability, recovery,
 * health monitoring, operational resilience (circuit breakers / timeouts / bulkheads / retries),
 * observability, security validation, and operational tooling — WITHOUT modifying any lower layer (each of
 * which already has its own `*-reliability` hardening). It hardens the FABRIC CONTROL PLANE (Sprint 1
 * orchestration + Sprint 2 routing + Sprint 3 optimization) by wrapping their operations at the call site.
 *
 * @security The reliability layer reasons over operation CONTROL-PLANE metadata ONLY — operation kind,
 * ids, states, latencies, health, and audit records. It NEVER handles message plaintext, ciphertext, or
 * key material; a no-content deep scan guards every persist.
 *
 * @performance Every vocabulary is a frozen table; circuit/breaker/retry/health decisions are
 * constant-time. The resilient-execute wrapper adds bounded, configurable overhead (a bulkhead slot + a
 * breaker check + a timer) around each fabric operation.
 *
 * @evolution This sprint FREEZES the architecture. The enums here (operation kinds, component kinds, event
 * types, metric names) are the stable extension surface future work registers against — voice/video,
 * federation, and clustering are explicitly out of scope and plug in as new operation/component kinds.
 */

// === operations ============================================================

/**
 * The kinds of fabric CONTROL-PLANE operation the reliability layer wraps + tracks. Each maps to a
 * circuit breaker + bulkhead + retry policy + recovery strategy.
 * @readonly @enum {string}
 */
export const FabricOperationKind = Object.freeze({
  COMMUNICATION_EXECUTE: "communication-execute", // Sprint 1 fabric.execute (the whole pipeline)
  DECISION: "decision", // Sprint 1/2 decision engine
  ROUTE_EVALUATE: "route-evaluate", // Sprint 2 adaptive routing
  CAPABILITY_COLLECT: "capability-collect", // Sprint 2 capability engine
  SCHEDULE: "schedule", // Sprint 3 optimizer/scheduler
  POLICY_EVALUATE: "policy-evaluate", // policy engines
  DISPATCH: "dispatch", // Sprint 3 dispatch drain
  SUBSYSTEM_CALL: "subsystem-call", // an orchestrated subsystem step
  RECOVERY: "recovery", // a recovery operation itself
});

export const ALL_OPERATION_KINDS = Object.freeze(Object.values(FabricOperationKind));

/** The lifecycle state of a tracked fabric operation. @readonly @enum {string} */
export const OperationState = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  TIMED_OUT: "timed-out",
  RECOVERING: "recovering",
  RECOVERED: "recovered",
  GRACEFULLY_FAILED: "gracefully-failed", // failed but degraded cleanly (no consistency breach)
  ABORTED: "aborted", // rejected before running (circuit open / bulkhead full / authz)
});

export const ALL_OPERATION_STATES = Object.freeze(Object.values(OperationState));

export const TERMINAL_OPERATION_STATES = Object.freeze([OperationState.SUCCEEDED, OperationState.FAILED, OperationState.RECOVERED, OperationState.GRACEFULLY_FAILED, OperationState.ABORTED]);

// === resilience ============================================================

/** Circuit-breaker states. @readonly @enum {string} */
export const CircuitState = Object.freeze({
  CLOSED: "closed", // healthy — calls flow
  OPEN: "open", // tripped — calls rejected fast
  HALF_OPEN: "half-open", // probing — a limited trial call allowed
});

export const ALL_CIRCUIT_STATES = Object.freeze(Object.values(CircuitState));

/**
 * Failure classification drives retry + circuit + recovery decisions. Transient/timeout/resource are
 * retryable + trip the breaker; validation/authorization are caller errors (no retry, no trip); permanent
 * is unrecoverable.
 * @readonly @enum {string}
 */
export const FailureClass = Object.freeze({
  TRANSIENT: "transient", // retryable (temporary glitch)
  TIMEOUT: "timeout", // exceeded the operation deadline
  RESOURCE: "resource", // resource exhaustion / backpressure (retry after backoff)
  VALIDATION: "validation", // bad input (do NOT retry, do NOT trip)
  AUTHORIZATION: "authorization", // unauthorized (do NOT retry, do NOT trip)
  PERMANENT: "permanent", // unrecoverable (no retry)
  UNKNOWN: "unknown", // unclassified (treated conservatively as transient once)
});

export const ALL_FAILURE_CLASSES = Object.freeze(Object.values(FailureClass));

/** Whether a failure class should be retried. */
export const RETRYABLE_CLASSES = Object.freeze([FailureClass.TRANSIENT, FailureClass.TIMEOUT, FailureClass.RESOURCE, FailureClass.UNKNOWN]);
/** Whether a failure class should count toward tripping a circuit breaker. */
export const CIRCUIT_TRIPPING_CLASSES = Object.freeze([FailureClass.TRANSIENT, FailureClass.TIMEOUT, FailureClass.RESOURCE]);

/** Backoff strategies for retry delay. @readonly @enum {string} */
export const BackoffStrategy = Object.freeze({
  FIXED: "fixed",
  LINEAR: "linear",
  EXPONENTIAL: "exponential",
  EXPONENTIAL_JITTER: "exponential-jitter",
});

export const ALL_BACKOFF_STRATEGIES = Object.freeze(Object.values(BackoffStrategy));

// === recovery ==============================================================

/** The outcome of a recovery attempt. @readonly @enum {string} */
export const RecoveryOutcome = Object.freeze({
  RESUMED: "resumed", // re-ran from checkpoint + succeeded
  REPLANNED: "replanned", // deferred / rescheduled for later
  GRACEFULLY_FAILED: "gracefully-failed", // degraded cleanly (consistency preserved)
  ABANDONED: "abandoned", // unrecoverable — abandoned after the recovery timeout
});

export const ALL_RECOVERY_OUTCOMES = Object.freeze(Object.values(RecoveryOutcome));

// === health ================================================================

/** Component health status. @readonly @enum {string} */
export const HealthStatus = Object.freeze({
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  UNHEALTHY: "unhealthy",
  UNKNOWN: "unknown",
});

export const ALL_HEALTH_STATUSES = Object.freeze(Object.values(HealthStatus));

/** Health rank (higher = worse) — used to roll a component set up to an overall status. */
export const HEALTH_RANK = Object.freeze({ healthy: 0, unknown: 1, degraded: 2, unhealthy: 3 });

/** The Fabric components the health manager continuously monitors. @readonly @enum {string} */
export const ComponentKind = Object.freeze({
  FABRIC: "fabric",
  DECISION_ENGINE: "decision-engine",
  CAPABILITY_ENGINE: "capability-engine",
  ROUTING: "routing",
  SCHEDULER: "scheduler",
  QOS: "qos",
  RESOURCE_MANAGER: "resource-manager",
  REPOSITORY: "repository",
  SUBSYSTEM_REGISTRY: "subsystem-registry",
  EXECUTION: "execution",
  RECOVERY: "recovery",
});

export const ALL_COMPONENT_KINDS = Object.freeze(Object.values(ComponentKind));

// === observability =========================================================

/** Stable metric names (Prometheus/OTel export uses these). @readonly @enum {string} */
export const MetricName = Object.freeze({
  COMMUNICATION_THROUGHPUT: "fabric_communication_throughput_total",
  DECISION_LATENCY: "fabric_decision_latency_ms",
  ROUTING_LATENCY: "fabric_routing_latency_ms",
  SCHEDULER_LATENCY: "fabric_scheduler_latency_ms",
  POLICY_EVAL_TIME: "fabric_policy_eval_ms",
  EXECUTION_SUCCESS_RATE: "fabric_execution_success_rate",
  RECOVERY_SUCCESS_RATE: "fabric_recovery_success_rate",
  SUBSYSTEM_AVAILABILITY: "fabric_subsystem_availability",
  QUEUE_DEPTH: "fabric_queue_depth",
  QOS_DISTRIBUTION: "fabric_qos_distribution_total",
  CIRCUIT_STATE: "fabric_circuit_state",
  OPERATION_LATENCY: "fabric_operation_latency_ms",
});

export const ALL_METRIC_NAMES = Object.freeze(Object.values(MetricName));

// === events ================================================================

/**
 * Reliability event types. A future admin/monitoring UI subscribes here. Events carry ids +
 * classifications + numbers only — never content/keys.
 * @readonly @enum {string}
 */
export const ReliabilityEventType = Object.freeze({
  OPERATION_STARTED: "reliability.operation_started",
  OPERATION_SUCCEEDED: "reliability.operation_succeeded",
  OPERATION_FAILED: "reliability.operation_failed",
  OPERATION_TIMED_OUT: "reliability.operation_timed_out",
  OPERATION_ABORTED: "reliability.operation_aborted",
  RETRY_SCHEDULED: "reliability.retry_scheduled",
  CIRCUIT_OPENED: "reliability.circuit_opened",
  CIRCUIT_HALF_OPEN: "reliability.circuit_half_open",
  CIRCUIT_CLOSED: "reliability.circuit_closed",
  BULKHEAD_REJECTED: "reliability.bulkhead_rejected",
  RECOVERY_STARTED: "reliability.recovery_started",
  RECOVERY_COMPLETED: "reliability.recovery_completed",
  GRACEFUL_DEGRADATION: "reliability.graceful_degradation",
  HEALTH_CHANGED: "reliability.health_changed",
  ALERT_RAISED: "reliability.alert_raised",
  SECURITY_AUDITED: "reliability.security_audited",
});

export const ALL_RELIABILITY_EVENT_TYPES = Object.freeze(Object.values(ReliabilityEventType));

/** Alert severities. @readonly @enum {string} */
export const AlertSeverity = Object.freeze({ INFO: "info", WARNING: "warning", CRITICAL: "critical" });

// === failure reasons =======================================================

/** Machine-readable reliability failure/validation reasons. */
export const ReliabilityFailureReason = Object.freeze({
  CIRCUIT_OPEN: "circuit-open",
  BULKHEAD_FULL: "bulkhead-full",
  TIMEOUT: "timeout",
  RETRY_EXHAUSTED: "retry-exhausted",
  RECOVERY_FAILED: "recovery-failed",
  UNAUTHORIZED: "unauthorized",
  REPLAY_DETECTED: "replay-detected",
  RATE_LIMITED: "rate-limited",
  INVALID_OPERATION: "invalid-operation",
  REPOSITORY_INCONSISTENT: "repository-inconsistent",
  CONFIGURATION_ERROR: "configuration-error",
  CONTENT_LEAK: "content-leak",
  INTERNAL_ERROR: "internal-error",
});

// === constants =============================================================

export const RELIABILITY_FRAMEWORK = "fabric-reliability";
export const RELIABILITY_SCHEMA_VERSION = 1;
export const RELIABILITY_LAYER = 12;
export const RELIABILITY_SPRINT = 4;
/** The frozen protocol version declared by the architecture freeze (STEP 15). */
export const FABRIC_PROTOCOL_VERSION = "1.0.0";

/** Default circuit-breaker config. */
export const DEFAULT_CIRCUIT = Object.freeze({ failureThreshold: 5, successThreshold: 2, resetTimeoutMs: 30_000, rollingWindowMs: 60_000 });

/** Default retry config. */
export const DEFAULT_RETRY = Object.freeze({ maxAttempts: 3, strategy: BackoffStrategy.EXPONENTIAL_JITTER, baseDelayMs: 100, maxDelayMs: 5_000, jitterRatio: 0.2 });

/** Default operation timeout (ms) per kind (fallback = DEFAULT_TIMEOUT_MS). */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Default bulkhead concurrency per compartment + max queued. */
export const DEFAULT_BULKHEAD = Object.freeze({ maxConcurrent: 64, maxQueue: 1_000 });

/** Recovery bounds. */
export const DEFAULT_RECOVERY = Object.freeze({ recoveryTimeoutMs: 30_000, maxResumeAttempts: 2, stalledAfterMs: 60_000 });

/** Bounded audit-trail + alert retention. */
export const MAX_AUDIT_ENTRIES = 200;
export const MAX_ALERTS = 500;

/** Pagination bounds. */
export const MAX_PAGE_SIZE = 1000;
export const DEFAULT_PAGE_SIZE = 100;

/**
 * @typedef {object} OperationCheckpoint A recoverable snapshot of an in-flight operation.
 * @property {string} operationId @property {string} kind one of {@link FabricOperationKind}
 * @property {string} state one of {@link OperationState} @property {number} attempt
 * @property {object} data opaque control-plane resume data (ids/stage — never content) @property {string} startedAt @property {string} updatedAt
 */

/**
 * @typedef {object} ResilientResult The outcome of a resilient operation.
 * @property {boolean} ok @property {string} operationId @property {string} kind @property {string} state
 * @property {any} [result] @property {object} [error] @property {number} attempts @property {number} latencyMs
 * @property {string} [recovery] one of {@link RecoveryOutcome} @property {boolean} [degraded]
 */

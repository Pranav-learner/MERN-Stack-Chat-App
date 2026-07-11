/**
 * @module network-reliability/types
 *
 * Enums + constants for the **Network Reliability & Production Hardening** subsystem — Layer 7,
 * Sprint 3, the capstone that makes the connectivity layer production-grade. It does NOT establish
 * connections; it makes the ACTIVE CONNECTIONS produced by Sprint 2 (the Connectivity Engine /
 * Connection Manager) *reliable*: automatic recovery, continuous health monitoring, retry policies,
 * observability, and a protocol freeze.
 *
 * @security This subsystem operates on connection CONTROL-PLANE metadata + numeric aggregates only —
 * connection ids, states, latencies, health scores, recovery reasons. It NEVER handles a private
 * key, session key, message key, chain key, or shared secret. Recovery PRESERVES the cryptographic
 * session by keeping `sessionId` stable across a reconnect (no re-handshake when avoidable), but it
 * never touches key bytes.
 *
 * @evolution Transport-INDEPENDENT: it manages an abstract {@link ActiveConnection} record + reacts
 * to its lifecycle via INJECTED recovery hooks (reconnect / refresh candidates / switch relay /
 * resume session). It works with whatever connection manager Sprint 2 provides — or reported state.
 * Layer 8 (P2P messaging / media) consumes healthy Active Connections; this sprint freezes their
 * interfaces.
 */

/**
 * The lifecycle state of an active connection (as the reliability layer tracks it).
 * @readonly @enum {string}
 */
export const ConnectionState = Object.freeze({
  NEW: "new", // registered, not yet connected
  CONNECTING: "connecting", // establishing (Sprint 2 owns this; reflected here)
  CONNECTED: "connected", // live + healthy
  DEGRADED: "degraded", // live but unhealthy (high latency / instability)
  RECONNECTING: "reconnecting", // transiently lost; attempting to restore the SAME session
  RECOVERING: "recovering", // running a recovery plan (refresh candidates / switch relay)
  DISCONNECTED: "disconnected", // connection lost (awaiting recovery/close)
  FAILED: "failed", // recovery exhausted
  CLOSED: "closed", // cleanly torn down (terminal)
});

/** All connection states. */
export const ALL_CONNECTION_STATES = Object.freeze(Object.values(ConnectionState));

/** States in which a connection is live / usable. */
export const LIVE_CONNECTION_STATES = Object.freeze([ConnectionState.CONNECTED, ConnectionState.DEGRADED]);

/** States from which a connection cannot progress further. */
export const TERMINAL_CONNECTION_STATES = Object.freeze([ConnectionState.FAILED, ConnectionState.CLOSED]);

/** Whether a state is terminal. @param {string} s @returns {boolean} */
export function isTerminalConnectionState(s) {
  return TERMINAL_CONNECTION_STATES.includes(s);
}

/** Whether a state is live (usable). @param {string} s @returns {boolean} */
export function isLiveConnectionState(s) {
  return LIVE_CONNECTION_STATES.includes(s);
}

/** The transport a connection is using (mirrors the candidate types). */
export const TransportKind = Object.freeze({
  HOST: "host", // direct, same network
  SERVER_REFLEXIVE: "srflx", // direct through NAT (hole-punched)
  RELAY: "relay", // TURN-relayed
  UNKNOWN: "unknown",
});

/**
 * What triggered a recovery. Each maps to a recovery action (see {@link module:network-reliability/recovery}).
 * @readonly @enum {string}
 */
export const RecoveryTrigger = Object.freeze({
  NETWORK_LOSS: "network-loss", // temporary loss of connectivity
  WIFI_TO_MOBILE: "wifi-to-mobile", // interface changed WiFi → cellular
  MOBILE_TO_WIFI: "mobile-to-wifi", // interface changed cellular → WiFi
  NAT_REBIND: "nat-rebind", // the NAT changed the public mapping
  CONNECTION_TIMEOUT: "connection-timeout", // heartbeat/activity timeout
  RELAY_FAILURE: "relay-failure", // the TURN relay failed
  UNEXPECTED_DISCONNECT: "unexpected-disconnect", // transport dropped
  REPOSITORY_FAILURE: "repository-failure", // a storage failure
});

/** All recovery triggers. */
export const ALL_RECOVERY_TRIGGERS = Object.freeze(Object.values(RecoveryTrigger));

/**
 * The action a recovery performs. All PRESERVE the cryptographic session where possible (resume,
 * not re-handshake). @readonly @enum {string}
 */
export const RecoveryAction = Object.freeze({
  RECONNECT: "reconnect", // re-establish the transport, resume the same session
  REFRESH_CANDIDATES: "refresh-candidates", // re-gather candidates (network changed) then reconnect
  SWITCH_RELAY: "switch-relay", // fail over to a relay transport
  RESUME_SESSION: "resume-session", // resume without a full reconnect (brief loss)
  GRACEFUL_FAIL: "graceful-fail", // give up cleanly (recovery exhausted)
});

/** Which action + recoverability each trigger defaults to. */
export const RECOVERY_PLANS = Object.freeze({
  [RecoveryTrigger.NETWORK_LOSS]: { action: RecoveryAction.RESUME_SESSION, recoverable: true },
  [RecoveryTrigger.WIFI_TO_MOBILE]: { action: RecoveryAction.REFRESH_CANDIDATES, recoverable: true },
  [RecoveryTrigger.MOBILE_TO_WIFI]: { action: RecoveryAction.REFRESH_CANDIDATES, recoverable: true },
  [RecoveryTrigger.NAT_REBIND]: { action: RecoveryAction.REFRESH_CANDIDATES, recoverable: true },
  [RecoveryTrigger.CONNECTION_TIMEOUT]: { action: RecoveryAction.RECONNECT, recoverable: true },
  [RecoveryTrigger.RELAY_FAILURE]: { action: RecoveryAction.SWITCH_RELAY, recoverable: true },
  [RecoveryTrigger.UNEXPECTED_DISCONNECT]: { action: RecoveryAction.RECONNECT, recoverable: true },
  [RecoveryTrigger.REPOSITORY_FAILURE]: { action: RecoveryAction.RECONNECT, recoverable: true },
});

/** Retry strategies for reconnection. @readonly @enum {string} */
export const RetryStrategy = Object.freeze({
  IMMEDIATE: "immediate", // retry at once, up to max
  FIXED: "fixed", // fixed delay between attempts
  EXPONENTIAL_BACKOFF: "exponential-backoff", // exp backoff (default)
  NONE: "none", // no automatic retry (manual only)
});

/** Connection health status. @readonly @enum {string} */
export const HealthStatus = Object.freeze({ HEALTHY: "healthy", DEGRADED: "degraded", UNHEALTHY: "unhealthy", UNKNOWN: "unknown" });

/** Metric kinds the {@link module:network-reliability/observability metrics registry} tracks. */
export const MetricType = Object.freeze({ COUNTER: "counter", GAUGE: "gauge", HISTOGRAM: "histogram" });

/** Canonical reliability metric names (stable — frozen interface). */
export const Metric = Object.freeze({
  CONNECTION_TOTAL: "reliability_connection_total",
  CONNECTION_SUCCESS: "reliability_connection_success_total",
  CONNECTION_FAILURE: "reliability_connection_failure_total",
  RECONNECT_TOTAL: "reliability_reconnect_total",
  RECOVERY_TOTAL: "reliability_recovery_total",
  RECOVERY_SUCCESS: "reliability_recovery_success_total",
  RECOVERY_FAILURE: "reliability_recovery_failure_total",
  LATENCY: "reliability_latency_ms",
  HEALTH_SCORE: "reliability_health_score",
  RELAY_USAGE: "reliability_relay_usage_total",
  CANDIDATE_SELECTION_TIME: "reliability_candidate_selection_time_ms",
  RECOVERY_TIME: "reliability_recovery_time_ms",
  HEARTBEAT_TOTAL: "reliability_heartbeat_total",
  HEARTBEAT_MISSED: "reliability_heartbeat_missed_total",
  ACTIVE_CONNECTIONS: "reliability_active_connections",
  ALERT_TOTAL: "reliability_alert_total",
});

/** Reliability event types (emitted on the {@link module:network-reliability/events bus}). */
export const ReliabilityEventType = Object.freeze({
  CONNECTION_REGISTERED: "reliability.connection_registered",
  CONNECTION_STATE_CHANGED: "reliability.connection_state_changed",
  CONNECTION_CLOSED: "reliability.connection_closed",
  HEARTBEAT_RECEIVED: "reliability.heartbeat_received",
  HEARTBEAT_MISSED: "reliability.heartbeat_missed",
  HEALTH_CHANGED: "reliability.health_changed",
  RECOVERY_STARTED: "reliability.recovery_started",
  RECOVERY_SUCCEEDED: "reliability.recovery_succeeded",
  RECOVERY_FAILED: "reliability.recovery_failed",
  RECONNECT_ATTEMPT: "reliability.reconnect_attempt",
  RELAY_FAILOVER: "reliability.relay_failover",
  ALERT_RAISED: "reliability.alert_raised",
  CACHE_INVALIDATED: "reliability.cache_invalidated",
});

/** Alert types the {@link module:network-reliability/monitoring monitor} raises. */
export const AlertType = Object.freeze({
  CONNECTION_FAILURE_SPIKE: "connection-failure-spike",
  REPEATED_RECOVERY_FAILURE: "repeated-recovery-failure",
  UNHEALTHY_CONNECTION: "unhealthy-connection",
  HEARTBEAT_TIMEOUT: "heartbeat-timeout",
  RELAY_OVERUSE: "relay-overuse",
  NAT_REBIND_STORM: "nat-rebind-storm",
  RECONNECT_STORM: "reconnect-storm",
});

/** Alert severities. */
export const AlertSeverity = Object.freeze({ INFO: "info", WARNING: "warning", CRITICAL: "critical" });

/** Machine-readable failure/validation reasons. */
export const ReliabilityFailureReason = Object.freeze({
  UNKNOWN_CONNECTION: "unknown-connection",
  INVALID_TRANSITION: "invalid-transition",
  RECOVERY_EXHAUSTED: "recovery-exhausted",
  UNRECOVERABLE: "unrecoverable",
  MALFORMED_CONNECTION: "malformed-connection",
  UNAUTHORIZED: "unauthorized",
  INTERNAL_ERROR: "internal-error",
});

/** The subsystem identifier + schema version. */
export const NETREL_FRAMEWORK = "network-reliability";
export const NETREL_SCHEMA_VERSION = 1;

/** The frozen Layer-7 connectivity control-plane version (bump = breaking change). */
export const CONNECTIVITY_VERSION = "1.0";

/** Default heartbeat interval (ms) a client should beat at. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

/** Default heartbeat timeout (ms) → a connection with no heartbeat this long is timed out. */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;

/** Default recovery timeout (ms) — total time a recovery may spend before graceful failure. */
export const DEFAULT_RECOVERY_TIMEOUT_MS = 30_000;

/** Default retry policy. */
export const DEFAULT_RETRY_POLICY = Object.freeze({
  strategy: RetryStrategy.EXPONENTIAL_BACKOFF,
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  factor: 2,
  jitter: true,
  cooldownMs: 1_000,
  recoveryTimeoutMs: DEFAULT_RECOVERY_TIMEOUT_MS,
});

/** Default monitor window (ms). */
export const DEFAULT_MONITOR_WINDOW_MS = 60_000;

/** Default alert thresholds per window. */
export const DEFAULT_ALERT_THRESHOLDS = Object.freeze({
  [AlertType.CONNECTION_FAILURE_SPIKE]: 20,
  [AlertType.REPEATED_RECOVERY_FAILURE]: 3,
  [AlertType.UNHEALTHY_CONNECTION]: 1,
  [AlertType.HEARTBEAT_TIMEOUT]: 5,
  [AlertType.RELAY_OVERUSE]: 50,
  [AlertType.NAT_REBIND_STORM]: 10,
  [AlertType.RECONNECT_STORM]: 15,
});

/** Health-score dimension weights (sum → 1). Higher score = healthier. */
export const HEALTH_WEIGHTS = Object.freeze({ latency: 0.35, stability: 0.3, activity: 0.2, age: 0.15 });

/** Latency (ms) at/above which the latency dimension scores 0 (a poor link). */
export const LATENCY_CEILING_MS = 1_000;

/** Default active-connection cache TTL (ms). */
export const DEFAULT_CACHE_TTL_MS = 10_000;

/** Default cache capacity before LRU eviction. */
export const DEFAULT_CACHE_LIMIT = 10_000;

/** Max pagination page size (API hardening). */
export const MAX_PAGE_SIZE = 200;
/** Default pagination page size. */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * @typedef {object} ActiveConnection The reliability layer's view of a connection produced by
 *   Sprint 2. CONTROL-PLANE metadata only — no key material.
 * @property {string} connectionId @property {string} deviceId @property {string} peerId
 * @property {string|null} sessionId the crypto session id (preserved across reconnect)
 * @property {string} planId the endpoint-selection/PDP plan this connection realized
 * @property {string} state one of {@link ConnectionState}
 * @property {string} transport one of {@link TransportKind}
 * @property {boolean} relayUsed @property {object} selectedPair the nominated candidate pair (public)
 * @property {object} health {@link ConnectionHealth}
 * @property {number} reconnectCount @property {number} recoveryCount
 * @property {object} retryPolicy @property {object} metadata
 * @property {string} establishedAt @property {string} updatedAt @property {string} lastActivityAt
 * @property {number} version @property {number} schemaVersion
 */

/**
 * @typedef {object} ConnectionHealth
 * @property {string} status one of {@link HealthStatus} @property {number} score `[0,1]`
 * @property {number} latencyMs @property {number|null} packetLoss FUTURE placeholder
 * @property {number|null} jitterMs FUTURE placeholder @property {number} stability `[0,1]`
 * @property {number} missedHeartbeats @property {string} lastHeartbeatAt @property {number} ageMs
 */

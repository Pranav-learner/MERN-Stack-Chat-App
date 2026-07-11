/**
 * @module network-reliability
 *
 * Public entry point of the **Network Reliability & Production Hardening** subsystem — Layer 7,
 * Sprint 3, the capstone that makes the connectivity layer production-grade. It makes the ACTIVE
 * CONNECTIONS produced by Sprint 2 reliable: automatic recovery, continuous health monitoring,
 * configurable retry policies, observability, alerting — and a protocol freeze.
 *
 * ## Out of scope (Layer 8)
 * NO peer-to-peer messaging, data channels, media streaming, file transfer, or application
 * messaging. This sprint makes connections reliable + freezes their interfaces; Layer 8 consumes a
 * HEALTHY Active Connection to build direct P2P comms (see {@link module:network-reliability/freeze}).
 *
 * @security Everything here is CONTROL-PLANE metadata only — connection ids, states, latencies,
 * health scores, recovery reasons, and the crypto `sessionId` (an id, not a key). Recovery preserves
 * the cryptographic session by keeping `sessionId` stable across a reconnect; it never touches keys.
 *
 * @example
 * ```js
 * import { NetworkReliabilityManager, createInMemoryReliabilityRepository, createReliabilityApi } from "./network-reliability/index.js";
 * const mgr = new NetworkReliabilityManager({ ...createInMemoryReliabilityRepository(), recoveryHooks });
 * const api = createReliabilityApi(mgr);
 * ```
 */

// Manager + API facade
export { NetworkReliabilityManager, toPublicConnection } from "./manager/networkReliabilityManager.js";
export { createReliabilityApi } from "./api/reliabilityApi.js";

// Lifecycle
export { ConnectionLifecycle, ALLOWED_TRANSITIONS, canTransition, assertTransition, nextStates } from "./manager/connectionLifecycle.js";

// Recovery + retry
export { RecoveryCoordinator, RECOVERY_PLANS, RecoveryTrigger, RecoveryAction } from "./recovery/recoveryCoordinator.js";
export { resolveRetryPolicy, nextDelay, shouldRetry, RetryController } from "./retry/retryPolicy.js";

// Health + heartbeat + diagnostics
export { computeHealth, healthForConnection, scoreToStatus } from "./health/healthMonitor.js";
export { HeartbeatMonitor } from "./heartbeat/heartbeatMonitor.js";
export { buildDiagnostics, stabilitySummary } from "./diagnostics/diagnostics.js";

// Observability + monitoring
export { ReliabilityMetrics } from "./observability/metrics.js";
export { ReliabilityMonitor } from "./monitoring/reliabilityMonitor.js";

// Repositories
export { createInMemoryReliabilityRepository } from "./repository/inMemoryReliabilityRepository.js";
export { createMongoReliabilityRepository } from "./repository/mongoReliabilityRepository.js";

// Security + freeze
export { API_SECURITY_POSTURE, SECURITY_ASSUMPTIONS, auditConnectivityApis, assertOwnership, normalizePagination } from "./security/securityAudit.js";
export { protocolManifest, FROZEN_VERSIONS, FROZEN_INTERFACES, EXTENSION_POINTS, isConnectivityCompatible } from "./freeze/protocolFreeze.js";

// Validation
export {
  validateConnectionId,
  validateRef,
  validateUserRef,
  validateTrigger,
  validateRetryPolicy,
  validateRegisterRequest,
  requireConnection,
  assertOwner,
  assertNoSecretMaterial,
  validateConnection,
  validateRepository,
  FORBIDDEN_SECRET_KEYS,
} from "./validators/validators.js";

// Events + errors + types
export { ReliabilityEventBus, ReliabilityEventType } from "./events/events.js";
export * from "./errors.js";
export {
  ConnectionState,
  ALL_CONNECTION_STATES,
  LIVE_CONNECTION_STATES,
  TERMINAL_CONNECTION_STATES,
  isTerminalConnectionState,
  isLiveConnectionState,
  TransportKind,
  RecoveryTrigger as RecoveryTriggerEnum,
  RecoveryAction as RecoveryActionEnum,
  RetryStrategy,
  HealthStatus,
  Metric,
  AlertType,
  AlertSeverity,
  NETREL_FRAMEWORK,
  NETREL_SCHEMA_VERSION,
  CONNECTIVITY_VERSION,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_RECOVERY_TIMEOUT_MS,
  DEFAULT_RETRY_POLICY,
} from "./types/types.js";

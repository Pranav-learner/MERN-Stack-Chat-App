/**
 * @module networking-hardening
 *
 * Public entry point of the **Production Networking Hardening** subsystem — Layer 6, Sprint 6, the
 * capstone that makes the Layer-6 networking control plane production-ready. It adds cross-cutting
 * concerns WITHOUT redesigning any subsystem: failure recovery, distributed consistency, security
 * validation + rate limiting, observability (metrics), monitoring + alerting, repository hardening,
 * and a protocol freeze.
 *
 * ## Out of scope (Layer 7)
 * NO NAT Traversal, ICE/STUN/TURN, WebRTC, P2P, socket creation, or relay connections. This sprint
 * hardens + freezes the control plane so Layer 7 builds on stable seams (see
 * {@link module:networking-hardening/freeze}).
 *
 * @security Everything here operates on METADATA + numeric aggregates only — never a private key,
 * session key, message key, chain key, or shared secret.
 *
 * @example
 * ```js
 * import { NetworkingHardeningManager, createHardeningApi } from "./networking-hardening/index.js";
 * const hardening = new NetworkingHardeningManager();
 * const api = createHardeningApi(hardening);
 * api.health();
 * ```
 */

// Manager + API facade
export { NetworkingHardeningManager } from "./manager/networkingHardeningManager.js";
export { createHardeningApi } from "./api/hardeningApi.js";

// Observability
export { NetworkingMetrics } from "./observability/metrics.js";

// Monitoring
export { NetworkMonitor } from "./monitoring/networkMonitor.js";

// Recovery
export { RecoveryCoordinator, RECOVERY_PLANS, RecoveryKind, RecoveryAction } from "./recovery/recoveryCoordinator.js";

// Consistency
export {
  assertVersion,
  isNewerVersion,
  resolveConflict,
  compareAndSet,
  IdempotencyStore,
} from "./consistency/consistency.js";

// Rate limiting + enumeration resistance
export { RateLimiter, uniformNotFound, areResponsesUniform } from "./ratelimit/rateLimiter.js";

// Repository hardening
export { CircuitBreaker, wrapRepository } from "./repository/resilientRepository.js";
export { createInMemoryHardeningRepository } from "./repository/inMemoryHardeningRepository.js";
export { createMongoHardeningRepository } from "./repository/mongoHardeningRepository.js";

// Security audit
export { API_SECURITY_POSTURE, auditNetworkingApis, assertOwnership, normalizePagination } from "./security/securityAudit.js";

// Freeze
export {
  protocolManifest,
  FROZEN_VERSIONS,
  FROZEN_INTERFACES,
  EXTENSION_POINTS,
  isControlPlaneCompatible,
} from "./freeze/protocolFreeze.js";

// Validation
export { validateAlert, validateRetryPolicy, assertNoSecretMaterial, validateRepository, FORBIDDEN_SECRET_KEYS } from "./validators/validators.js";

// Events + errors + types
export { HardeningEventBus, HardeningEventType } from "./events/events.js";
export * from "./errors.js";
export {
  MetricType,
  Metric,
  AlertType,
  AlertSeverity,
  HealthStatus,
  CircuitState,
  HARDENING_FRAMEWORK,
  HARDENING_SCHEMA_VERSION,
  NETWORKING_CONTROL_PLANE_VERSION,
  DEFAULT_MONITOR_WINDOW_MS,
  DEFAULT_ALERT_THRESHOLDS,
  DEFAULT_RETRY_POLICY,
  DEFAULT_CIRCUIT_CONFIG,
  DEFAULT_RATE_LIMIT,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
} from "./types/types.js";

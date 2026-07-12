/**
 * @module fabric-reliability
 *
 * **Layer 12 · Sprint 4 — Production Communication Fabric.** The final, INDEPENDENT subsystem that makes
 * the whole Communication Fabric (Sprint 1 orchestration + Sprint 2 adaptive routing + Sprint 3 global
 * optimization) production-grade: reliability, recovery, health monitoring, operational resilience
 * (circuit breakers / timeouts / bulkheads / retries), observability (metrics + Prometheus/OTel +
 * structured logging + tracing), security validation, and operational tooling — WITHOUT modifying any
 * lower layer. It hardens the FABRIC CONTROL PLANE by wrapping its operations at the call site.
 *
 * The core is the {@link FabricReliabilityManager}: its `run(kind, executor, opts)` composes every
 * resilience pattern — security → circuit breaker → bulkhead → retry → timeout → execute → recover →
 * gracefully degrade — with metrics, tracing, and an audit trail around each fabric operation.
 *
 * @security The reliability layer reasons over operation CONTROL-PLANE metadata ONLY — kind, ids, states,
 * latencies, failure classes, health. Never plaintext/ciphertext/keys; a no-content scan guards every
 * persist. It centralises + audits authorization, replay protection, and rate-limiting for every
 * orchestration decision.
 *
 * @evolution This sprint FREEZES the Layer-12 architecture (see {@link getProtocolFreeze}). Voice, video,
 * federation, multi-cluster, and ML are explicitly out of scope and plug in as new operation/component
 * kinds against the documented, stable extension points.
 *
 * @example
 * ```js
 * import { FabricReliabilityManager, createReliabilityApi, createInMemoryReliabilityRepository, createReliableFabric } from "./fabric-reliability/index.js";
 * const rm = new FabricReliabilityManager({ ...createInMemoryReliabilityRepository() });
 * const reliableFabric = createReliableFabric({ fabricApi, reliabilityManager: rm });
 * const result = await reliableFabric.execute(request, { callerId });   // circuit-broken, retried, recovered, audited
 * const health = await rm.readiness();                                   // operational tooling
 * ```
 */

// Types + errors + events
export * from "./types/types.js";
export * from "./errors.js";
export { FabricReliabilityEventBus } from "./events/events.js";

// Resilience primitives
export { CircuitBreaker, CircuitBreakerRegistry } from "./circuit-breaker/circuitBreaker.js";
export { withTimeout, TimeoutPolicy } from "./timeout/timeout.js";
export { RetryPolicy } from "./retry/retryPolicy.js";
export { Bulkhead, BulkheadRegistry } from "./retry/bulkhead.js";
export { FailureClassifier, DEFAULT_CLASSIFICATION_RULES } from "./retry/failureClassifier.js";

// Recovery
export { createCheckpoint, patchCheckpoint, isTerminal } from "./recovery/checkpoint.js";
export { RecoveryEngine } from "./recovery/recoveryEngine.js";
export { createDefaultRecoveryStrategies, defaultRecoveryStrategy } from "./recovery/recoveryStrategies.js";
export { GracefulDegradation } from "./recovery/degradation.js";

// Health + observability + diagnostics
export { HealthManager, ProbeRegistry, rollup } from "./health/healthManager.js";
export { FabricMetrics } from "./monitoring/metrics.js";
export { FabricMonitor } from "./monitoring/monitor.js";
export { Tracer } from "./monitoring/tracing.js";
export { Diagnostics } from "./diagnostics/diagnostics.js";

// Security + validators + serializers
export { SecurityValidator } from "./validators/securityValidator.js";
export * from "./validators/validators.js";
export { toResultView, toHealthView, toDiagnosticsView, toOperationView } from "./serializers/serializers.js";

// Repositories
export { createInMemoryReliabilityRepository } from "./repository/inMemoryReliabilityRepository.js";
export { createMongoReliabilityRepository } from "./repository/mongoReliabilityRepository.js";

// Manager + freeze + API + integration
export { FabricReliabilityManager, toErrorInfo } from "./manager/reliabilityManager.js";
export { getProtocolFreeze } from "./freeze/protocolFreeze.js";
export { createReliabilityApi } from "./api/reliabilityApi.js";
export { createReliableFabric } from "./integration/fabricIntegration.js";

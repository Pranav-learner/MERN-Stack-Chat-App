/**
 * @module synchronization-reliability
 *
 * **Layer 9 · Sprint 3 — Synchronization Reliability & Production Hardening.** The capstone that makes
 * the offline-synchronization + state-replication layer production-grade: interrupted-sync recovery,
 * device-crash / app-restart resume, continuous health monitoring, replica-drift tracking, configurable
 * retry policies, observability (metrics + Prometheus/OTel hooks), security validation, and a protocol
 * freeze declaring the stable interfaces + Layer 10 extension points.
 *
 * @security Operates on CONTROL-PLANE metadata + numeric aggregates ONLY — never message content or
 * keys. Recovery PRESERVES replica consistency (the monotonic checkpoint) so it can never corrupt a
 * replica.
 *
 * @evolution Transport-INDEPENDENT: recovery calls INJECTED hooks. Layer 10 (secure group
 * communication) builds on the frozen interfaces + the checkpoint/resume seam WITHOUT modifying the
 * synchronization architecture.
 *
 * @example
 * ```js
 * import { SyncReliabilityManager, createInMemoryReliabilityRepository, createReliabilityApi, SyncMetrics } from "./synchronization-reliability/index.js";
 * const metrics = new SyncMetrics();
 * const mgr = new SyncReliabilityManager({ ...createInMemoryReliabilityRepository(), metrics, recoveryHooks });
 * const api = createReliabilityApi(mgr, { metrics });
 * ```
 */

// Types + errors
export * from "./types/types.js";
export * from "./errors.js";

// Lifecycle FSM
export { ALLOWED_TRANSITIONS, canTransition, assertTransition, nextStates, ReliabilityLifecycle } from "./manager/syncReliabilityLifecycle.js";

// Recovery + retry
export { RecoveryCoordinator } from "./recovery/recoveryCoordinator.js";
export { advanceCheckpoint, planResume } from "./recovery/checkpoint.js";
export { resolveRetryPolicy, computeBackoff, shouldRetry, withinBudget, nextRetryAt } from "./retry/retryPolicy.js";

// Monitoring + health + diagnostics
export { SyncMetrics } from "./monitoring/metrics.js";
export { scoreHealth, SyncHealthMonitor } from "./health/healthMonitor.js";
export { SyncMonitor } from "./monitoring/syncMonitor.js";
export { buildDiagnostics } from "./diagnostics/diagnostics.js";

// Security + freeze
export * from "./security/securityAudit.js";
export { protocolManifest, isSyncLayerCompatible, FROZEN_VERSIONS, FROZEN_INTERFACES, EXTENSION_POINTS, DOES_NOT_IMPLEMENT } from "./freeze/protocolFreeze.js";

// Validators + events
export * from "./validators/validators.js";
export { ReliabilityEventBus } from "./events/events.js";

// Repositories
export { createInMemoryReliabilityRepository } from "./repository/inMemoryReliabilityRepository.js";
export { createMongoReliabilityRepository } from "./repository/mongoReliabilityRepository.js";

// Manager + API
export { SyncReliabilityManager } from "./manager/syncReliabilityManager.js";
export { createReliabilityApi } from "./api/reliabilityApi.js";

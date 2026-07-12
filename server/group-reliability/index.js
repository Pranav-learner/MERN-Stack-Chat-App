/**
 * @module group-reliability
 *
 * **Layer 10 · Sprint 3 — Group Reliability & Production Hardening.** The capstone that makes the Secure
 * Group Communication platform (Group Foundation Sprint 1 + Group Communication Engine Sprint 2)
 * production-grade: interrupted-messaging / failed-fan-out / rekey / membership / replica /
 * synchronization / offline recovery, continuous health monitoring (per-operation + per-group),
 * configurable retry policies, observability (metrics + Prometheus/OTel hooks), security validation +
 * audit, and a protocol freeze declaring the stable interfaces + Sprint 4 extension points.
 *
 * @security Operates on group CONTROL-PLANE metadata + numeric aggregates ONLY — never message content
 * or keys. Recovery PRESERVES consistency (the monotonic operation checkpoint) so a resume re-runs only
 * the remaining targets; it never corrupts group state.
 *
 * @evolution Transport-INDEPENDENT: recovery calls INJECTED hooks. Sprint 4 (Group Delivery & Read
 * Receipt Engine) builds on the frozen interfaces + the checkpoint/resume + event seams WITHOUT
 * modifying the group architecture.
 *
 * @example
 * ```js
 * import { GroupReliabilityManager, createInMemoryGroupReliabilityRepository, createGroupReliabilityApi, GroupMetrics } from "./group-reliability/index.js";
 * const metrics = new GroupMetrics();
 * const mgr = new GroupReliabilityManager({ ...createInMemoryGroupReliabilityRepository(), metrics, recoveryHooks });
 * const api = createGroupReliabilityApi(mgr, { metrics });
 * ```
 */

// Types + errors
export * from "./types/types.js";
export * from "./errors.js";

// Lifecycle FSM
export { ALLOWED_TRANSITIONS, canTransition, assertTransition, nextStates, ReliabilityLifecycle } from "./manager/groupReliabilityLifecycle.js";

// Recovery + retry
export { RecoveryCoordinator } from "./recovery/recoveryCoordinator.js";
export { advanceCheckpoint, planResume } from "./recovery/checkpoint.js";
export { resolveRetryPolicy, computeBackoff, shouldRetry, withinBudget, nextRetryAt } from "./retry/retryPolicy.js";

// Monitoring + health + diagnostics
export { GroupMetrics } from "./monitoring/metrics.js";
export { scoreHealth, scoreGroupHealth, GroupHealthMonitor } from "./health/healthMonitor.js";
export { GroupMonitor } from "./monitoring/groupMonitor.js";
export { buildDiagnostics } from "./diagnostics/diagnostics.js";

// Security + freeze
export * from "./security/securityAudit.js";
export { protocolManifest, isGroupLayerCompatible, FROZEN_VERSIONS, FROZEN_INTERFACES, EXTENSION_POINTS, DOES_NOT_IMPLEMENT } from "./freeze/protocolFreeze.js";

// Validators + events
export * from "./validators/validators.js";
export { GroupReliabilityEventBus } from "./events/events.js";

// Repositories
export { createInMemoryGroupReliabilityRepository } from "./repository/inMemoryGroupReliabilityRepository.js";
export { createMongoGroupReliabilityRepository } from "./repository/mongoGroupReliabilityRepository.js";

// Manager + API
export { GroupReliabilityManager } from "./manager/groupReliabilityManager.js";
export { createGroupReliabilityApi } from "./api/reliabilityApi.js";

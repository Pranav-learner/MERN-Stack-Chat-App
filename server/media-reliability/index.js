/**
 * @module media-reliability
 *
 * **Layer 11 · Sprint 3 — Media Reliability & Production Hardening.** The capstone that makes the Secure
 * Media Platform (Media Pipeline Sprint 1 + Media Delivery Engine Sprint 2) production-grade: interrupted-
 * upload / interrupted-download / streaming / pipeline / storage / synchronization recovery, continuous
 * health monitoring (per-operation + per-media), configurable retry policies, observability (metrics +
 * Prometheus/OTel hooks), a hot-metadata cache with hit-rate observability, security validation + audit,
 * and a protocol freeze declaring the stable interfaces + Layer 12 extension points.
 *
 * @security Operates on media CONTROL-PLANE metadata + numeric aggregates ONLY — never media content or
 * keys. Recovery PRESERVES integrity + metadata consistency (the monotonic operation checkpoint) so a
 * resume re-transfers only the remaining chunks; it never corrupts media state.
 *
 * @evolution Storage-provider-INDEPENDENT: recovery calls INJECTED hooks. Layer 12 (Distributed Hybrid
 * Architecture) builds on the frozen interfaces + the checkpoint/resume + event + cache seams WITHOUT
 * modifying the media architecture.
 *
 * @example
 * ```js
 * import { MediaReliabilityManager, createInMemoryMediaReliabilityRepository, createMediaReliabilityApi, MediaMetrics } from "./media-reliability/index.js";
 * const metrics = new MediaMetrics();
 * const mgr = new MediaReliabilityManager({ ...createInMemoryMediaReliabilityRepository(), metrics, recoveryHooks });
 * const api = createMediaReliabilityApi(mgr, { metrics });
 * ```
 */

// Types + errors
export * from "./types/types.js";
export * from "./errors.js";

// Lifecycle FSM
export { ALLOWED_TRANSITIONS, canTransition, assertTransition, nextStates, ReliabilityLifecycle } from "./manager/mediaReliabilityLifecycle.js";

// Recovery + retry
export { RecoveryCoordinator } from "./recovery/recoveryCoordinator.js";
export { advanceCheckpoint, planResume } from "./recovery/checkpoint.js";
export { resolveRetryPolicy, computeBackoff, shouldRetry, withinBudget, nextRetryAt } from "./retry/retryPolicy.js";

// Monitoring + health + diagnostics + cache
export { MediaMetrics } from "./monitoring/metrics.js";
export { scoreHealth, scoreMediaHealth, MediaHealthMonitor } from "./health/healthMonitor.js";
export { MediaMonitor } from "./monitoring/mediaMonitor.js";
export { buildDiagnostics } from "./diagnostics/diagnostics.js";
export { MediaCache } from "./cache/mediaCache.js";

// Security + freeze
export * from "./security/securityAudit.js";
export { protocolManifest, isMediaLayerCompatible, FROZEN_VERSIONS, FROZEN_INTERFACES, EXTENSION_POINTS, DOES_NOT_IMPLEMENT } from "./freeze/protocolFreeze.js";

// Validators + events
export * from "./validators/validators.js";
export { MediaReliabilityEventBus } from "./events/events.js";

// Repositories
export { createInMemoryMediaReliabilityRepository } from "./repository/inMemoryMediaReliabilityRepository.js";
export { createMongoMediaReliabilityRepository } from "./repository/mongoMediaReliabilityRepository.js";

// Manager + API
export { MediaReliabilityManager } from "./manager/mediaReliabilityManager.js";
export { createMediaReliabilityApi } from "./api/reliabilityApi.js";

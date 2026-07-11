/**
 * @module transport-reliability
 *
 * **Layer 8 · Sprint 3 — Data Plane Reliability & Production Hardening.** The capstone that makes the
 * peer-to-peer Data Plane (Reliable Messaging + Transport Engine) production-grade: interrupted-
 * transfer recovery, resume-from-checkpoint, connection migration (WiFi ↔ mobile), continuous health
 * monitoring, observability (metrics + Prometheus/OTel hooks), security validation, and a protocol
 * freeze declaring the stable interfaces + Layer 9 extension points.
 *
 * @security Operates on CONTROL-PLANE metadata + numeric aggregates ONLY — never payload bytes or
 * keys. Recovery + migration PRESERVE the transfer's checkpoint (resume, never restart) so they can
 * never corrupt transfer state.
 *
 * @evolution Transport-INDEPENDENT: recovery + migration call INJECTED hooks. Layer 9 (Offline
 * Encrypted Synchronization) builds on the frozen interfaces + the checkpoint/resume seam WITHOUT
 * modifying the transport architecture.
 *
 * @example
 * ```js
 * import { TransportReliabilityManager, createInMemoryReliabilityRepository, createReliabilityApi, TransferMetrics } from "./transport-reliability/index.js";
 * const metrics = new TransferMetrics();
 * const mgr = new TransportReliabilityManager({ ...createInMemoryReliabilityRepository(), metrics, recoveryHooks, migrationHooks });
 * const api = createReliabilityApi(mgr, { metrics });
 * await api.register({ transferId, conversationId, senderDeviceId, receiverDeviceId, connectionId, totalChunks: 64 });
 * ```
 */

// Types + errors
export * from "./types/types.js";
export * from "./errors.js";

// Lifecycle FSM
export { ALLOWED_TRANSITIONS, canTransition, assertTransition, nextStates, ReliabilityLifecycle } from "./manager/transferReliabilityLifecycle.js";

// Recovery, resume, migration
export { RecoveryCoordinator } from "./recovery/recoveryCoordinator.js";
export { planResume, advanceCheckpoint } from "./resume/resumePlanner.js";
export { ConnectionMigrator } from "./migration/connectionMigrator.js";

// Monitoring + observability + diagnostics
export { TransferMetrics } from "./monitoring/metrics.js";
export { scoreHealth, TransferHealthMonitor } from "./monitoring/healthMonitor.js";
export { TransportMonitor } from "./monitoring/transportMonitor.js";
export { buildDiagnostics } from "./diagnostics/diagnostics.js";

// Security + freeze
export * from "./security/securityAudit.js";
export { protocolManifest, isDataPlaneCompatible, FROZEN_VERSIONS, FROZEN_INTERFACES, EXTENSION_POINTS, DOES_NOT_IMPLEMENT } from "./freeze/protocolFreeze.js";

// Validators + events
export * from "./validators/validators.js";
export { ReliabilityEventBus } from "./events/events.js";

// Repositories
export { createInMemoryReliabilityRepository } from "./repository/inMemoryReliabilityRepository.js";
export { createMongoReliabilityRepository } from "./repository/mongoReliabilityRepository.js";

// Manager + API
export { TransportReliabilityManager } from "./manager/transportReliabilityManager.js";
export { createReliabilityApi } from "./api/reliabilityApi.js";

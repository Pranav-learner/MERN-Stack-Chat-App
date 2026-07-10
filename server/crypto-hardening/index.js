/**
 * @module crypto-hardening
 *
 * Public entry point of the **Production Cryptographic Hardening** subsystem — Layer 5,
 * Sprint 6. This sprint adds **no new cryptography**. It hardens the Layer 2–5 crypto pipeline
 * into a production-ready secure-messaging engine:
 *
 * - **ReplayGuard** — transport-level replay resistance (sequence / generation / duplicate
 *   ciphertext / window / TTL / reconnect recovery);
 * - **KeyLifecycleVerifier** — verifies every key lifecycle + the no-key-material invariant;
 * - **RecoveryCoordinator** — graceful recovery + cleanup for interrupted/corrupted operations;
 * - **MetricsRegistry** — production metrics with Prometheus / OpenTelemetry hooks;
 * - **SecurityMonitor** — anomaly detection + alerting;
 * - **protocolManifest** — the frozen interfaces + Layer 6 extension points.
 *
 * @security Everything here is additive defence-in-depth over the unchanged crypto layers and
 * operates on PUBLIC metadata only — never key bytes.
 *
 * @example
 * ```js
 * import { ReplayGuard, MetricsRegistry, SecurityMonitor } from "./crypto-hardening/index.js";
 * const metrics = new MetricsRegistry();
 * const guard = new ReplayGuard({ metrics });
 * const monitor = new SecurityMonitor({ metrics }); monitor.subscribe(guard.events);
 * if (!guard.accept({ sessionId, generation, messageNumber, nonce }).ok) return; // drop replay
 * ```
 */

// Replay + lifecycle + recovery
export { ReplayGuard } from "./replay/replayGuard.js";
export {
  KeyLifecycleVerifier,
  findKeyMaterial,
  verifyMessageKeyLifecycle,
  verifyForwardSecrecyLifecycle,
  verifyKeyHierarchyLifecycle,
  verifyDestructionAudit,
} from "./lifecycle/lifecycleVerifier.js";
export { RecoveryCoordinator, RECOVERY_PLANS } from "./recovery/recoveryCoordinator.js";

// Observability + monitoring
export { MetricsRegistry } from "./observability/metrics.js";
export { SecurityMonitor } from "./monitoring/securityMonitor.js";

// Protocol freeze
export {
  FROZEN_VERSIONS,
  FROZEN_INTERFACES,
  EXTENSION_POINTS,
  assertCompatible,
  protocolManifest,
} from "./freeze/protocolFreeze.js";

// Repositories + events + audit + validators
export { createInMemoryHardeningRepository } from "./repository/inMemoryHardeningRepository.js";
export { createMongoHardeningRepository } from "./repository/mongoHardeningRepository.js";
export { HardeningEventBus, HardeningEventType } from "./events/events.js";
export { auditEntry, appendAudit, assertNoSecretMaterial, AuditAction } from "./audit/audit.js";
export { validateSessionRef, validateReplayContext, validateAlert, validateRepository } from "./validators/validators.js";

// Errors + types
export * from "./errors.js";
export {
  ReplayVerdict,
  MetricType,
  AlertType,
  AlertSeverity,
  RecoveryKind,
  RecoveryAction,
  HardeningEventType as HardeningEvents,
  KeyPhase,
  DEFAULT_REPLAY_WINDOW,
  DEFAULT_REPLAY_TTL_MS,
  DEFAULT_MONITOR_WINDOW_MS,
  HARDENING_SCHEMA_VERSION,
} from "./types/types.js";

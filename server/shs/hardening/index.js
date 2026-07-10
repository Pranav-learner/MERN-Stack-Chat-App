/**
 * @module shs/hardening
 *
 * Public entry point of the Secure Handshake **Hardening** subsystem — Layer 4,
 * Sprint 4. Production resilience layered ADDITIVELY over Sprints 1–3: replay +
 * downgrade protection, protocol integrity, recovery, continuous session validation,
 * observability, and repository hardening — plus the security audit + protocol freeze.
 *
 * ## Out of scope (Layer 5)
 * NO forward secrecy, NO double ratchet, NO message encryption, NO transport
 * encryption. Hardening does not change the Sprint 1–3 protocol; it protects it.
 *
 * @example
 * ```js
 * import { ReplayProtector, assertNoDowngrade, SessionGuard, MetricsCollector, HealthMonitor } from "./shs/hardening/index.js";
 * ```
 */

// Errors + types + events
export * from "./errors.js";
export {
  ReplayReason,
  DowngradeReason,
  IntegrityReason,
  RecoveryAction,
  FailureClass,
  HealthStatus,
  HardeningEventType,
} from "./types.js";
export { HardeningEventBus } from "./events/events.js";

// Replay protection
export { ReplayCache } from "./replay/replayCache.js";
export { checkTimestamp, isFresh, DEFAULT_MAX_AGE_MS, DEFAULT_MAX_SKEW_MS } from "./replay/timestampValidator.js";
export { ReplayProtector } from "./replay/replayProtector.js";

// Downgrade protection
export {
  checkDowngrade,
  assertNoDowngrade,
  assertTranscriptMatch,
  transcriptHash,
  maxCommonVersion,
  INSECURE_VERSIONS,
} from "./downgrade/downgradeGuard.js";

// Protocol integrity
export {
  validateHeaders,
  validateOrdering,
  validateTransition,
  validateSessionMetadata,
  verifyInboundMessage,
  TranscriptAccumulator,
  EXPECTED_MESSAGES_BY_STATE,
} from "./integrity/protocolIntegrity.js";

// Recovery
export { RecoveryManager, classifyFailure, decideRecovery } from "./recovery/recoveryManager.js";

// Session guard
export { SessionGuard } from "./session-guard/sessionGuard.js";

// Observability
export { MetricsCollector, Metric } from "./observability/metrics.js";
export { Tracer, Span } from "./observability/tracer.js";
export { HealthMonitor } from "./observability/healthMonitor.js";

// Repository hardening
export { hardenRepository, KeyedMutex } from "./repository/hardenedRepository.js";

// Audit
export { securityAudit, ControlStatus } from "./audit/securityAudit.js";

// Protocol freeze
export { PROTOCOL_MANIFEST, EXTENSION_POINTS, manifestHash, assertFrozen } from "./protocol/freeze.js";

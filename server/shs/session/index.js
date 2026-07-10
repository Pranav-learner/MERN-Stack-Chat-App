/**
 * @module shs/session
 *
 * Public entry point of the **Secure Session** subsystem — Layer 4, Sprint 3:
 * Secure Session Establishment. Transforms the Sprint 2 shared secret into a
 * complete, reusable Secure Session with derived session keys, a deterministic
 * lifecycle, expiration, resumption, and a rekey framework.
 *
 * ## Out of scope for Sprint 3
 * NO encrypted chat messages, NO forward secrecy, NO double ratchet, NO message
 * ratcheting, NO encrypted media, NO P2P/WebRTC, NO transport encryption. Session
 * keys are derived + stored (device-local); future layers consume them.
 *
 * @example Device wiring (tests / client-equivalent, zero deps)
 * ```js
 * import { SecureSessionManager, createInMemorySessionRepository, SecureKeyStore } from "./shs/session/index.js";
 * const sessions = new SecureSessionManager({ ...createInMemorySessionRepository(), keyStore: new SecureKeyStore() });
 * ```
 *
 * @example Descriptor wiring (server)
 * ```js
 * import { SecureSessionManager, createMongoSessionRepository } from "./shs/session/index.js";
 * const sessions = new SecureSessionManager({ ...createMongoSessionRepository() }); // no key store
 * ```
 */

// Manager + repositories + key store
export { SecureSessionManager } from "./manager/sessionManager.js";
export { createInMemorySessionRepository } from "./repository/inMemoryRepository.js";
export { createMongoSessionRepository } from "./repository/mongoRepository.js";
export { SecureKeyStore } from "./storage/secureKeyStore.js";

// Errors + types
export * from "./errors.js";
export {
  SessionState,
  ALL_SESSION_STATES,
  ACTIVE_SESSION_STATES,
  TERMINAL_SESSION_STATES,
  isTerminalSessionState,
  isActiveSessionState,
  KeyPurpose,
  SessionEventType,
  SessionFailureReason,
  SESSION_KEY_ALGORITHM,
  SESSION_MAC_ALGORITHM,
  SESSION_KDF,
  SESSION_KEY_BYTES,
} from "./types.js";

// Key derivation
export {
  deriveSessionKeys,
  disposeSessionKeys,
  buildContext,
  infoLabel,
  NAMESPACE,
  DERIVATION_VERSION,
  KDF_NAME,
} from "./derivation/sessionKeys.js";

// Lifecycle
export {
  SessionLifecycle,
  ALLOWED_TRANSITIONS,
  canTransition,
  assertTransition,
  nextStates,
} from "./lifecycle/lifecycle.js";

// Model
export {
  createSecureSession,
  isSessionTerminal,
  isParticipant,
  participantsKey,
  DEFAULT_MAX_LIFETIME_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
} from "./model/secureSession.js";

// Expiration
export {
  isExpired,
  isLifetimeExpired,
  isIdleExpired,
  shouldGoIdle,
  remainingLifetimeMs,
  activityStamp,
  selectExpired,
} from "./expiration/expiration.js";

// Resumption
export {
  issueResumeToken,
  verifyResumeToken,
  resumeMetadata,
  RESUME_TOKEN_VERSION,
  DEFAULT_RESUME_TOKEN_TTL_MS,
} from "./resumption/resumption.js";

// Rekey framework
export {
  hkdfGenerationStrategy,
  REKEY_STRATEGIES,
  resolveStrategy,
  rekeyRecord,
  canRekey,
} from "./rekey/rekey.js";

// Validation
export {
  validateSessionId,
  requireSession,
  assertNotExpired,
  validateMetadata,
  assertNoDuplicate,
  assertParticipant,
  assertParticipantsMatch,
  validateRepository,
} from "./validators/validators.js";

// Serialization
export { toPublicSession } from "./serialization/sessionSerializer.js";

// Events
export { SessionEventBus } from "./events/events.js";

// Migration
export { SESSION_SCHEMA_VERSION, sessionReport, sweepExpiredSessions } from "./migration/migration.js";

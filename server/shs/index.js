/**
 * @module shs
 *
 * Public entry point of the **Secure Handshake System (SHS)** — Layer 4, Sprint 1:
 * Protocol Foundation. This is the operating system that future handshake logic
 * runs on: a deterministic protocol state machine, a lifecycle manager, session
 * model, message models, serialization, validation, negotiation, timeout/retry
 * frameworks, events, and repositories.
 *
 * ## Explicitly out of scope for Sprint 1
 * NO ECDH, NO shared secrets, NO session keys, NO forward secrecy, NO double
 * ratchet, NO encrypted messages, NO P2P/WebRTC/NAT, NO transport encryption, NO
 * cryptographic suite negotiation. Those plug INTO this framework in later sprints.
 *
 * @example Production wiring
 * ```js
 * import { HandshakeManager, createMongoShsRepository } from "./shs/index.js";
 * const handshakes = new HandshakeManager({
 *   ...createMongoShsRepository(),
 *   identityLookup: (u) => identityManager.getIdentityByUser(u),
 *   deviceLookup: (u, d) => deviceManager.getDevice(u, d),
 * });
 * ```
 *
 * @example Tests (in-memory, zero deps)
 * ```js
 * import { HandshakeManager, createInMemoryShsRepository } from "./shs/index.js";
 * const handshakes = new HandshakeManager({ ...createInMemoryShsRepository() });
 * ```
 */

// Manager + repositories
export { HandshakeManager } from "./manager/handshakeManager.js";
export { createInMemoryShsRepository } from "./repository/inMemoryRepository.js";
export { createMongoShsRepository } from "./repository/mongoRepository.js";

// Errors + types
export * from "./errors.js";
export {
  HandshakeState,
  ALL_HANDSHAKE_STATES,
  ACTIVE_HANDSHAKE_STATES,
  TERMINAL_HANDSHAKE_STATES,
  isTerminalState,
  isActiveState,
  HandshakeRole,
  MessageType,
  ALL_MESSAGE_TYPES,
  HandshakeEventType,
  FailureReason,
  ActorType,
} from "./types.js";

// State machine
export {
  HandshakeStateMachine,
  ALLOWED_TRANSITIONS,
  canTransition,
  assertTransition,
  nextStates,
} from "./state-machine/stateMachine.js";

// Sessions
export {
  createSession,
  isSessionTerminal,
  isSessionActive,
  isResumable,
  isParty,
  roleOf,
} from "./sessions/session.js";

// Messages
export {
  buildRequest,
  buildResponse,
  buildAccept,
  buildReject,
  buildCancel,
  buildTimeout,
  buildResume,
  buildComplete,
  buildFailure,
  buildError,
  MESSAGE_BUILDERS,
  assertEnvelope,
} from "./messages/messages.js";

// Serialization
export {
  serialize,
  deserialize,
  toJson,
  fromJson,
  toBinary,
  fromBinary,
  toCompact,
  fromCompact,
  crc32,
  SerializationFormat,
} from "./serializers/serializer.js";
export { toPublicSession } from "./serializers/sessionSerializer.js";

// Validation
export {
  validateMessage,
  validateVersionCompatibility,
  validateAgainstSession,
  validateParties,
  assertNotDuplicate,
  isExpired,
  assertNotExpired,
} from "./validators/validators.js";

// Negotiation
export { negotiate, canNegotiate } from "./negotiation/negotiation.js";

// Protocol version + constants
export {
  CURRENT_VERSION,
  MINIMUM_VERSION,
  SUPPORTED_VERSIONS,
  VERSION_FEATURES,
  parseVersion,
  isSupported,
  isCompatible,
  compare,
  negotiateVersion,
  featuresForVersion,
  versionDescriptor,
} from "./protocol/version.js";
export {
  PROTOCOL_NAME,
  PROTOCOL_MAGIC,
  DEFAULT_HANDSHAKE_TTL_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  FrameFlags,
} from "./protocol/constants.js";

// Timeout + retry
export { TimeoutScheduler, deadlineFrom, isElapsed, remainingMs } from "./timeout/timeout.js";
export { RetryPolicy, BackoffStrategy } from "./retry/retry.js";

// Events
export { HandshakeEventBus } from "./events/events.js";

// Migration
export { SHS_SCHEMA_VERSION, handshakeReport, sweepStaleSessions } from "./migration/migration.js";

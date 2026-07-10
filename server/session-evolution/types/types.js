/**
 * @module session-evolution/types
 *
 * Enums and type declarations for the **Session Evolution Framework** (Layer 5,
 * Sprint 1). This sprint builds the reusable ARCHITECTURE that lets a cryptographic
 * session evolve over time — generations, evolution state, policies, a scheduler,
 * versioned history, metadata, validation, and events.
 *
 * @security This sprint introduces **NO cryptography**. It does NOT derive, rotate, or
 * ratchet any key. It never touches key bytes or shared secrets. It only tracks that a
 * {@link module:shs/session} Secure Session HAS a generation and MIGHT evolve, and
 * records WHEN evolution should occur. Future Layer 5 sprints (Forward Secrecy,
 * Automatic Rekeying, Chain Keys, Message Keys, Double Ratchet, Post-Compromise
 * Security) plug their key mechanics INTO this framework instead of redesigning it.
 *
 * @evolution The framework is transport-independent: REST, WebSocket, WebRTC, and P2P
 * transports all reuse it. An evolution record is a PUBLIC metadata sidecar keyed by a
 * session id — it is additive and never modifies the Secure Session schema.
 */

/**
 * Evolution lifecycle states. An evolution record is a deterministic finite state
 * machine over these (see {@link module:session-evolution/lifecycle}).
 *
 * - `INITIALIZED` — record created for a session; not yet activated.
 * - `STABLE`      — steady state; generation is current, no evolution pending.
 * - `SCHEDULED`   — a future evolution has been deferred (dueAt in the future).
 * - `PENDING`     — a policy has triggered; evolution is awaiting execution.
 * - `EVOLVING`    — transient: a generation advance is in progress (framework only —
 *                   NO keys are generated in Sprint 1).
 * - `EVOLVED`     — transient: a generation advance just completed; returns to STABLE.
 * - `CANCELLED`   — a scheduled/pending evolution was cancelled; returns to STABLE.
 * - `FAILED`      — evolution validation failed (corrupted/invalid); recoverable.
 * - `RETIRED`     — the underlying session ended; evolution tracking stopped (terminal).
 * @readonly @enum {string}
 */
export const EvolutionState = Object.freeze({
  INITIALIZED: "initialized",
  STABLE: "stable",
  SCHEDULED: "scheduled",
  PENDING: "pending",
  EVOLVING: "evolving",
  EVOLVED: "evolved",
  CANCELLED: "cancelled",
  FAILED: "failed",
  RETIRED: "retired",
});

/** All evolution states, in canonical order. */
export const ALL_EVOLUTION_STATES = Object.freeze(Object.values(EvolutionState));

/** States in which an evolution record is live / can still progress. */
export const ACTIVE_EVOLUTION_STATES = Object.freeze([
  EvolutionState.INITIALIZED,
  EvolutionState.STABLE,
  EvolutionState.SCHEDULED,
  EvolutionState.PENDING,
  EvolutionState.EVOLVING,
  EvolutionState.EVOLVED,
  EvolutionState.CANCELLED,
]);

/** States that indicate an evolution is queued (scheduled or triggered). */
export const PENDING_EVOLUTION_STATES = Object.freeze([
  EvolutionState.SCHEDULED,
  EvolutionState.PENDING,
]);

/** States from which an evolution record cannot return to active tracking. */
export const TERMINAL_EVOLUTION_STATES = Object.freeze([EvolutionState.RETIRED]);

/** Whether a state is terminal. @param {string} state @returns {boolean} */
export function isTerminalEvolutionState(state) {
  return TERMINAL_EVOLUTION_STATES.includes(state);
}

/** Whether a state is live / trackable. @param {string} state @returns {boolean} */
export function isActiveEvolutionState(state) {
  return ACTIVE_EVOLUTION_STATES.includes(state);
}

/** Whether an evolution is queued (scheduled or pending). @param {string} state @returns {boolean} */
export function isPendingEvolutionState(state) {
  return PENDING_EVOLUTION_STATES.includes(state);
}

/**
 * The kinds of evolution policy — each describes WHEN a session should evolve, never
 * HOW (no rekeying happens in this sprint). See {@link module:session-evolution/policies}.
 * @readonly @enum {string}
 */
export const PolicyType = Object.freeze({
  TIME_BASED: "time-based", // evolve after an interval elapses
  MESSAGE_COUNT: "message-count", // evolve after N messages
  MANUAL: "manual", // evolve only when explicitly requested
  SECURITY_EVENT: "security-event", // evolve on a security signal (e.g. suspected compromise)
  DEVICE_EVENT: "device-event", // evolve on a device change (add/remove/rotate)
  ADMINISTRATOR: "administrator", // evolve on an administrator directive
  CUSTOM: "custom", // evolve per a caller-supplied predicate
});

/** All known policy types. */
export const ALL_POLICY_TYPES = Object.freeze(Object.values(PolicyType));

/**
 * What triggered (or would trigger) an evolution — recorded on version history and
 * pending schedules for auditability.
 * @readonly @enum {string}
 */
export const EvolutionTrigger = Object.freeze({
  POLICY: "policy",
  MANUAL: "manual",
  SCHEDULED: "scheduled",
  SECURITY_EVENT: "security-event",
  DEVICE_EVENT: "device-event",
  ADMINISTRATOR: "administrator",
  SESSION_REKEY: "session-rekey", // mirrors a Layer 4 rekey into a generation bump
  SYSTEM: "system",
});

/**
 * Evolution event types. Future layers (Forward Secrecy, Ratcheting) subscribe to
 * these. See {@link module:session-evolution/events}.
 * @readonly @enum {string}
 */
export const EvolutionEventType = Object.freeze({
  CREATED: "evolution.created",
  SCHEDULED: "evolution.scheduled",
  VALIDATED: "evolution.validated",
  GENERATION_ADVANCED: "evolution.generation_advanced",
  POLICY_TRIGGERED: "evolution.policy_triggered",
  POLICY_UPDATED: "evolution.policy_updated",
  CANCELLED: "evolution.cancelled",
  RETIRED: "evolution.retired",
  FAILED: "evolution.failed",
});

/**
 * Machine-readable reasons attached to failure/cancel transitions + validation results.
 * @readonly @enum {string}
 */
export const EvolutionFailureReason = Object.freeze({
  UNKNOWN_SESSION: "unknown-session",
  UNKNOWN_EVOLUTION: "unknown-evolution",
  INVALID_STATE: "invalid-state",
  INVALID_TRANSITION: "invalid-transition",
  INVALID_GENERATION: "invalid-generation",
  DUPLICATE_GENERATION: "duplicate-generation",
  CORRUPTED_METADATA: "corrupted-metadata",
  DUPLICATE_EVOLUTION: "duplicate-evolution",
  POLICY_CONFLICT: "policy-conflict",
  EXPIRED_SESSION: "expired-session",
  RETIRED: "retired",
  MALFORMED_REQUEST: "malformed-request",
  INTERNAL_ERROR: "internal-error",
});

/** Current evolution-record storage schema version (for future forward-migrations). */
export const EVOLUTION_SCHEMA_VERSION = 1;

/** The framework identifier stamped onto security metadata. */
export const EVOLUTION_FRAMEWORK = "session-evolution";

/** The first generation number every session starts at. */
export const INITIAL_GENERATION = 0;

/**
 * @typedef {object} KeyVersion Pointer into a session's generation timeline. In Sprint
 *   1 these are integers only — NO key material is attached. Future sprints map each
 *   version to real derived keys.
 * @property {number} current the version tied to the active generation
 * @property {number|null} previous the version superseded by the last evolution (or null)
 * @property {number|null} next the reserved next version (or null when none is planned)
 */

/**
 * @typedef {object} PolicyDescriptor A serializable description of WHEN to evolve. Holds
 *   no key material and (except {@link PolicyType.CUSTOM}) no functions.
 * @property {string} id stable policy id
 * @property {string} type one of {@link PolicyType}
 * @property {object} params type-specific parameters (e.g. `{ intervalMs }`)
 * @property {string} [description] human-readable summary
 * @property {boolean} [enabled=true] whether the policy participates in evaluation
 * @property {(state: EvolutionRecord, context: object) => (boolean|{triggered:boolean,reason?:string})} [evaluate]
 *   in-memory-only predicate for CUSTOM policies (never serialized)
 */

/**
 * @typedef {object} VersionHistoryEntry One generation advance in the timeline.
 * @property {number} generation @property {number} keyVersion
 * @property {number} [previousGeneration] @property {number|null} [previousKeyVersion]
 * @property {string} at ISO timestamp @property {string} [reason] @property {string} [trigger]
 */

/**
 * @typedef {object} PendingEvolution A deferred/triggered evolution awaiting execution.
 *   Sprint 1 records this but NEVER executes it.
 * @property {string} evolutionId @property {string} sessionId
 * @property {string} [policyId] @property {string} [policyType]
 * @property {string} trigger one of {@link EvolutionTrigger}
 * @property {string} [reason] @property {string} scheduledAt ISO
 * @property {string|null} [dueAt] ISO — when a deferred evolution becomes due
 * @property {number} targetGeneration the generation this evolution would produce
 */

/**
 * @typedef {object} EvolutionRecord PUBLIC evolution sidecar for a Secure Session
 *   (metadata ONLY — never key bytes).
 * @property {string} evolutionId @property {string} sessionId @property {string} [handshakeId]
 * @property {string} state one of {@link EvolutionState}
 * @property {number} generation current generation number
 * @property {KeyVersion} keyVersion
 * @property {VersionHistoryEntry[]} versionHistory
 * @property {PolicyDescriptor[]} policies
 * @property {PendingEvolution|null} pending
 * @property {string} createdAt @property {string} updatedAt @property {string|null} lastEvolutionAt
 * @property {object} evolutionMetadata @property {object} policyMetadata
 * @property {object} securityMetadata @property {object[]} audit
 * @property {object} ratchetMetadata FUTURE — placeholder for ratchet state
 * @property {object} chainMetadata FUTURE — placeholder for chain-key state
 * @property {object} messageMetadata FUTURE — placeholder for message-key state
 * @property {object} metadata free-form
 * @property {Array<{from:string|null,to:string,at:string,reason?:string}>} history state transitions
 * @property {number} schemaVersion
 */

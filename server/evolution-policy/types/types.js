/**
 * @module evolution-policy/types
 *
 * Enums and type declarations for the **Automatic Rekeying & Evolution Policy** engine
 * (Layer 5, Sprint 3). This sprint makes cryptographic session evolution *automatic*:
 * secure sessions rekey themselves according to configurable policies, with no manual or
 * developer intervention.
 *
 * ## What this sprint adds (and what it reuses)
 * It is an ORCHESTRATION layer. It does NOT derive or destroy keys — that is the Sprint 2
 * {@link module:forward-secrecy} engine, which it drives. It does NOT re-implement policy
 * descriptors — it reuses the Sprint 1 {@link module:session-evolution/policies} factories
 * (and adds a `session-age` policy). It contributes: a policy engine that binds + evaluates
 * policies per session, a full rekey **execution state machine** (pending → executing →
 * completed/failed, with retry, cancellation, and conflict resolution), autonomous
 * scheduling + triggers, and transparent Secure Transport integration.
 *
 * @security Automatic evolution is guarded against abuse/DoS by a per-session **cooldown**
 * and by **generation-based deduplication** (a stale trigger for an already-advanced
 * generation is coalesced, never re-run). All records + events carry METADATA only — never
 * keys (the crypto lives entirely in the Sprint 2 engine).
 *
 * @out-of-scope Chain Keys, Message Keys, Double Ratchet, Post-Compromise Security — later
 * sprints derive those FROM these automatically-evolving generations.
 */

/**
 * The policy kinds the engine understands. The shared kinds reuse the Sprint 1
 * {@link module:session-evolution/types}.PolicyType string values verbatim so descriptors
 * interoperate; `SESSION_AGE` is added by this sprint.
 * @readonly @enum {string}
 */
export const PolicyType = Object.freeze({
  MANUAL: "manual",
  TIME_BASED: "time-based",
  MESSAGE_COUNT: "message-count",
  SECURITY_EVENT: "security-event",
  DEVICE_EVENT: "device-event",
  SESSION_AGE: "session-age", // NEW in Sprint 3
  ADMINISTRATOR: "administrator", // future administrator-defined policies
  CUSTOM: "custom",
});

/** All policy types. */
export const ALL_POLICY_TYPES = Object.freeze(Object.values(PolicyType));

/** Policy types of which only one may be attached to a session (attaching two conflicts). */
export const SINGLETON_POLICY_TYPES = Object.freeze([PolicyType.MANUAL, PolicyType.ADMINISTRATOR, PolicyType.SESSION_AGE]);

/**
 * What triggered a rekey evaluation/execution.
 * @readonly @enum {string}
 */
export const TriggerType = Object.freeze({
  MANUAL: "manual",
  TIME: "time",
  MESSAGE_COUNT: "message-count",
  DEVICE_EVENT: "device-event",
  SECURITY_EVENT: "security-event",
  SESSION_AGE: "session-age",
  IDENTITY_CHANGE: "identity-change",
  SESSION_EXPIRING: "session-expiring",
  RECONNECT: "reconnect",
  SCHEDULED: "scheduled",
  POLICY: "policy",
});

/**
 * Lifecycle of a single rekey execution (the execution framework's state machine).
 *
 * - `PENDING`   — created / queued; not yet running.
 * - `EXECUTING` — the underlying forward-secrecy evolution is in flight.
 * - `COMPLETED` — the generation advanced successfully.
 * - `FAILED`    — all retry attempts exhausted.
 * - `CANCELLED` — cancelled before running, or coalesced (a duplicate/stale trigger).
 * @readonly @enum {string}
 */
export const ExecutionState = Object.freeze({
  PENDING: "pending",
  EXECUTING: "executing",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

/** All execution states. */
export const ALL_EXECUTION_STATES = Object.freeze(Object.values(ExecutionState));

/** Execution states that are terminal (no further transitions). */
export const TERMINAL_EXECUTION_STATES = Object.freeze([ExecutionState.COMPLETED, ExecutionState.FAILED, ExecutionState.CANCELLED]);

/** Whether an execution state is terminal. */
export function isTerminalExecutionState(state) {
  return TERMINAL_EXECUTION_STATES.includes(state);
}

/** Whether an execution is live (occupying the per-session slot). */
export function isActiveExecutionState(state) {
  return state === ExecutionState.PENDING || state === ExecutionState.EXECUTING;
}

/**
 * Rekey engine event types. Future layers consume these.
 * @readonly @enum {string}
 */
export const RekeyEventType = Object.freeze({
  POLICY_EVALUATED: "rekey.policy_evaluated",
  POLICY_TRIGGERED: "rekey.policy_triggered",
  REKEY_QUEUED: "rekey.queued",
  REKEY_STARTED: "rekey.started",
  REKEY_COMPLETED: "rekey.completed",
  REKEY_FAILED: "rekey.failed",
  REKEY_RETRY: "rekey.retry",
  REKEY_CANCELLED: "rekey.cancelled",
  GENERATION_UPDATED: "rekey.generation_updated",
  TRANSPORT_UPDATED: "rekey.transport_updated",
  POLICY_CONFIGURED: "rekey.policy_configured",
});

/**
 * Machine-readable failure/skip reasons.
 * @readonly @enum {string}
 */
export const RekeyFailureReason = Object.freeze({
  UNKNOWN_SESSION: "unknown-session",
  NOT_CONFIGURED: "not-configured",
  DUPLICATE_EXECUTION: "duplicate-execution",
  GENERATION_MISMATCH: "generation-mismatch",
  CONCURRENT_EVOLUTION: "concurrent-evolution",
  POLICY_CONFLICT: "policy-conflict",
  INVALID_SCHEDULE: "invalid-schedule",
  SESSION_EXPIRED: "session-expired",
  COOLDOWN_ACTIVE: "cooldown-active",
  REPLAY: "replay",
  MALFORMED_REQUEST: "malformed-request",
  EVOLUTION_ERROR: "evolution-error",
  COALESCED: "coalesced-stale-generation",
  INTERNAL_ERROR: "internal-error",
});

/** Default minimum interval between two AUTOMATIC rekeys (abuse/DoS guard). */
export const DEFAULT_COOLDOWN_MS = 5 * 1000;
/** Default number of evolution attempts before an execution is marked FAILED. */
export const DEFAULT_MAX_ATTEMPTS = 2;
/** Cap on retained execution-history entries per session. */
export const DEFAULT_HISTORY_LIMIT = 200;
/** Current policy-state storage schema version. */
export const REKEY_SCHEMA_VERSION = 1;

/**
 * @typedef {object} RekeyPolicyConfig Per-session automatic-rekey configuration.
 * @property {boolean} enabled whether automatic rekeying is active
 * @property {number} cooldownMs minimum ms between automatic rekeys
 * @property {number} maxAttempts evolution attempts before FAILED
 */

/**
 * @typedef {object} RekeyExecution A single rekey operation's record (metadata only).
 * @property {string} executionId @property {string} sessionId
 * @property {string} state one of {@link ExecutionState}
 * @property {string} trigger one of {@link TriggerType} @property {string} [policyId] @property {string} [reason]
 * @property {number} [expectedGeneration] the generation observed when the trigger fired
 * @property {number} [resultGeneration] the generation produced on success
 * @property {number} attempts @property {number} maxAttempts @property {string} [error]
 * @property {string} createdAt @property {string} [startedAt] @property {string} [completedAt] @property {string} [failedAt]
 */

/**
 * @typedef {object} RekeyPolicyState PUBLIC per-session policy + execution sidecar.
 * @property {string} sessionId @property {string} [handshakeId]
 * @property {import("../../session-evolution/types/types.js").PolicyDescriptor[]} policies
 * @property {RekeyPolicyConfig} config
 * @property {number} currentGeneration @property {number} messageCount
 * @property {string|null} lastRekeyAt @property {string|null} lastEvaluationAt
 * @property {RekeyExecution|null} pending @property {RekeyExecution[]} executions
 * @property {Array<{generation:number,trigger:string,reason?:string,at:string}>} rekeyHistory
 * @property {object[]} audit @property {object} metadata @property {object} security
 * @property {string} createdAt @property {string} updatedAt @property {number} schemaVersion
 */

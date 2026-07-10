/**
 * @module shs/session/types
 *
 * Enums and type declarations for the Secure Session subsystem (Layer 4, Sprint 3 —
 * Secure Session Establishment). Transforms the Sprint 2 shared secret into a
 * reusable **Secure Session** with derived session keys, a lifecycle, expiration,
 * resumption, and a rekey framework.
 *
 * @security A Secure Session RECORD holds only PUBLIC metadata + key METADATA
 * (algorithm, length, keyId, fingerprint) — never raw key bytes. The raw
 * encryption/MAC keys live in a device-local {@link module:shs/session/storage}
 * secure key store and are never serialized, persisted to the server, or returned by
 * any API. This sprint derives + stores session keys; it does NOT encrypt messages.
 */

/**
 * Secure-session lifecycle states. The session is a deterministic finite state
 * machine over these (see {@link module:shs/session/lifecycle}).
 *
 * Active states:
 * - `CREATED`   — session object + keys derived; not yet activated.
 * - `ACTIVE`    — usable; the steady state.
 * - `IDLE`      — no activity within the idle timeout (still resumable).
 * - `PAUSED`    — explicitly suspended by the app (still resumable).
 * - `RESUMED`   — transient state entered on resume, before returning to ACTIVE.
 *
 * Terminal / semi-terminal states:
 * - `EXPIRED`   — passed its maximum lifetime.
 * - `CLOSED`    — gracefully ended (metadata retained).
 * - `DESTROYED` — keys wiped + record removed (fully terminal).
 * - `INVALID`   — failed validation (corrupted/mismatched).
 * - `FAILED`    — an error ended the session.
 * @readonly @enum {string}
 */
export const SessionState = Object.freeze({
  CREATED: "created",
  ACTIVE: "active",
  IDLE: "idle",
  PAUSED: "paused",
  RESUMED: "resumed",
  EXPIRED: "expired",
  CLOSED: "closed",
  DESTROYED: "destroyed",
  INVALID: "invalid",
  FAILED: "failed",
});

/** All session states, in canonical order. */
export const ALL_SESSION_STATES = Object.freeze(Object.values(SessionState));

/** States in which a session is usable / can still progress. */
export const ACTIVE_SESSION_STATES = Object.freeze([
  SessionState.CREATED,
  SessionState.ACTIVE,
  SessionState.IDLE,
  SessionState.PAUSED,
  SessionState.RESUMED,
]);

/** States from which a session cannot return to active use. */
export const TERMINAL_SESSION_STATES = Object.freeze([
  SessionState.CLOSED,
  SessionState.DESTROYED,
  SessionState.INVALID,
  SessionState.FAILED,
]);

/** Whether a state is terminal. @param {string} state @returns {boolean} */
export function isTerminalSessionState(state) {
  return TERMINAL_SESSION_STATES.includes(state);
}

/** Whether a state is active/usable. @param {string} state @returns {boolean} */
export function isActiveSessionState(state) {
  return ACTIVE_SESSION_STATES.includes(state);
}

/**
 * Key derivation purposes — the "purpose separation" labels fed into HKDF so each
 * derived key is cryptographically independent. Mirrors the Layer 2 SDK's
 * `DerivationPurpose`.
 * @readonly @enum {string}
 */
export const KeyPurpose = Object.freeze({
  ENCRYPTION: "encryption",
  AUTHENTICATION: "authentication", // MAC key
  INITIALIZATION: "initialization", // IV/nonce base material
  RATCHET: "ratchet", // future Layer 5 root material
  RESUMPTION: "resumption", // signs resume tokens
  KEY_ID: "key-id", // PUBLIC key identifier
});

/**
 * Session event types. Future layers (encrypted messaging in Layer 5) subscribe.
 * @readonly @enum {string}
 */
export const SessionEventType = Object.freeze({
  CREATED: "session.created",
  ACTIVATED: "session.activated",
  IDLE: "session.idle",
  PAUSED: "session.paused",
  RESUMED: "session.resumed",
  EXPIRED: "session.expired",
  CLOSED: "session.closed",
  DESTROYED: "session.destroyed",
  VALIDATED: "session.validated",
  FAILED: "session.failed",
  REKEY_REQUESTED: "session.rekey_requested",
  REKEYED: "session.rekeyed",
});

/**
 * Machine-readable reasons attached to failure/invalid transitions.
 * @readonly @enum {string}
 */
export const SessionFailureReason = Object.freeze({
  EXPIRED: "expired",
  IDLE_TIMEOUT: "idle-timeout",
  UNKNOWN_SESSION: "unknown-session",
  INVALID_STATE: "invalid-state",
  CORRUPTED_METADATA: "corrupted-metadata",
  DUPLICATE_SESSION: "duplicate-session",
  PARTICIPANT_MISMATCH: "participant-mismatch",
  INVALID_ID: "invalid-id",
  VALIDATION_FAILED: "validation-failed",
  INTERNAL_ERROR: "internal-error",
});

/** Default session key algorithm metadata (keys are derived but NOT used to encrypt yet). */
export const SESSION_KEY_ALGORITHM = "aes-256-gcm";
export const SESSION_MAC_ALGORITHM = "hmac-sha256";
export const SESSION_KDF = "hkdf-sha256";
export const SESSION_KEY_BYTES = 32;

/**
 * @typedef {object} SecureSession PUBLIC session record (metadata + key metadata ONLY).
 * @property {string} sessionId
 * @property {string} handshakeId the Sprint 1/2 handshake this session came from
 * @property {string[]} participants [initiatorUserId, responderUserId]
 * @property {{ initiator?: string, responder?: string }} deviceIds
 * @property {string} protocolVersion
 * @property {{ algorithm: string, length: number, keyId: string, fingerprint: string }} encryptionKey key METADATA (no bytes)
 * @property {{ algorithm: string, length: number }} authenticationKey key METADATA (no bytes)
 * @property {string} status one of {@link SessionState}
 * @property {number} generation rekey generation counter
 * @property {Array<{ generation: number, at: string, reason?: string }>} rekeyHistory
 * @property {string} createdAt @property {string} lastActivityAt @property {string} expiresAt
 * @property {number} maxLifetimeMs @property {number} idleTimeoutMs
 * @property {{ kdf: string, contextSeparated: boolean, purposeSeparated: boolean }} security
 * @property {object} metadata @property {object} extensions future extension fields
 * @property {string} updatedAt
 */

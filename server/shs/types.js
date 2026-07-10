/**
 * @module shs/types
 *
 * Enums and type declarations for the Secure Handshake System (Layer 4, Sprint 1 —
 * Protocol Foundation). Frozen objects act as enums in plain JS.
 *
 * ## Scope of Sprint 1
 * This module defines the PROTOCOL FRAMEWORK only. There is **no** cryptographic
 * key exchange, no shared secret, no session key, and no message encryption here.
 * A handshake "session" is a lifecycle/state container that future sprints will
 * plug ECDH / ratchet logic into — it deliberately stores NO secret material.
 *
 * @security Every value modelled here is PUBLIC protocol metadata (ids, states,
 * versions, capabilities). Private keys and shared secrets never appear.
 */

/**
 * Lifecycle states of a handshake session. The protocol is a deterministic finite
 * state machine over these states (see {@link module:shs/state-machine}).
 *
 * Active (non-terminal) states:
 * - `CREATED`      — session object created, nothing negotiated yet.
 * - `INITIALIZED`  — initiator prepared the request (version/capabilities set).
 * - `WAITING`      — request emitted; awaiting the responder.
 * - `NEGOTIATING`  — both parties present; negotiating version/capabilities.
 *
 * Terminal states:
 * - `COMPLETED`    — protocol handshake concluded successfully (no keys in S1).
 * - `FAILED`       — a protocol/validation error ended the handshake.
 * - `CANCELLED`    — the initiator cancelled before completion.
 * - `EXPIRED`      — the session passed its expiry deadline.
 * - `TIMED_OUT`    — a step deadline elapsed with no response.
 * - `REJECTED`     — the responder explicitly declined.
 * - `ABORTED`      — force-terminated (system/admin/error recovery).
 * @readonly @enum {string}
 */
export const HandshakeState = Object.freeze({
  CREATED: "created",
  INITIALIZED: "initialized",
  WAITING: "waiting",
  NEGOTIATING: "negotiating",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  TIMED_OUT: "timed_out",
  REJECTED: "rejected",
  ABORTED: "aborted",
});

/** All handshake states, in canonical order. */
export const ALL_HANDSHAKE_STATES = Object.freeze([
  HandshakeState.CREATED,
  HandshakeState.INITIALIZED,
  HandshakeState.WAITING,
  HandshakeState.NEGOTIATING,
  HandshakeState.COMPLETED,
  HandshakeState.FAILED,
  HandshakeState.CANCELLED,
  HandshakeState.EXPIRED,
  HandshakeState.TIMED_OUT,
  HandshakeState.REJECTED,
  HandshakeState.ABORTED,
]);

/** Active (non-terminal) states — a handshake here can still progress. */
export const ACTIVE_HANDSHAKE_STATES = Object.freeze([
  HandshakeState.CREATED,
  HandshakeState.INITIALIZED,
  HandshakeState.WAITING,
  HandshakeState.NEGOTIATING,
]);

/** Terminal states — no further transitions are allowed. */
export const TERMINAL_HANDSHAKE_STATES = Object.freeze([
  HandshakeState.COMPLETED,
  HandshakeState.FAILED,
  HandshakeState.CANCELLED,
  HandshakeState.EXPIRED,
  HandshakeState.TIMED_OUT,
  HandshakeState.REJECTED,
  HandshakeState.ABORTED,
]);

/** Whether a state is terminal. @param {string} state @returns {boolean} */
export function isTerminalState(state) {
  return TERMINAL_HANDSHAKE_STATES.includes(state);
}

/** Whether a state is active (non-terminal). @param {string} state @returns {boolean} */
export function isActiveState(state) {
  return ACTIVE_HANDSHAKE_STATES.includes(state);
}

/**
 * The role a party plays in a handshake.
 * @readonly @enum {string}
 */
export const HandshakeRole = Object.freeze({
  INITIATOR: "initiator",
  RESPONDER: "responder",
});

/**
 * Protocol message types (see {@link module:shs/messages}). Every message on the
 * wire carries one of these `type` values. NONE of these carry key material in
 * Sprint 1 — they carry protocol metadata only.
 * @readonly @enum {string}
 */
export const MessageType = Object.freeze({
  REQUEST: "handshake.request",
  RESPONSE: "handshake.response",
  ACCEPT: "handshake.accept",
  REJECT: "handshake.reject",
  CANCEL: "handshake.cancel",
  TIMEOUT: "handshake.timeout",
  RESUME: "handshake.resume",
  COMPLETE: "handshake.complete",
  FAILURE: "handshake.failure",
  ERROR: "handshake.error",
});

/** All message types, in canonical order. */
export const ALL_MESSAGE_TYPES = Object.freeze(Object.values(MessageType));

/**
 * Internal handshake event types. Future layers subscribe to these to react to
 * handshake progress (e.g. a crypto sprint kicking off ECDH on `ACCEPTED`).
 * @readonly @enum {string}
 */
export const HandshakeEventType = Object.freeze({
  STARTED: "handshake.started",
  NEGOTIATING: "handshake.negotiating",
  ACCEPTED: "handshake.accepted",
  REJECTED: "handshake.rejected",
  CANCELLED: "handshake.cancelled",
  EXPIRED: "handshake.expired",
  RESUMED: "handshake.resumed",
  COMPLETED: "handshake.completed",
  FAILED: "handshake.failed",
  TIMEOUT: "handshake.timeout",
  RESTARTED: "handshake.restarted",
  ABORTED: "handshake.aborted",
  STATE_CHANGED: "handshake.state_changed",
});

/**
 * Machine-readable reasons attached to failure/reject/abort transitions. Surfaced
 * to clients and future layers; stable strings (do not renumber).
 * @readonly @enum {string}
 */
export const FailureReason = Object.freeze({
  VERSION_INCOMPATIBLE: "version-incompatible",
  CAPABILITY_MISMATCH: "capability-mismatch",
  UNKNOWN_IDENTITY: "unknown-identity",
  UNKNOWN_DEVICE: "unknown-device",
  UNTRUSTED_DEVICE: "untrusted-device",
  MALFORMED_MESSAGE: "malformed-message",
  DUPLICATE_REQUEST: "duplicate-request",
  EXPIRED_SESSION: "expired-session",
  TIMEOUT: "timeout",
  RETRY_EXHAUSTED: "retry-exhausted",
  USER_REJECTED: "user-rejected",
  USER_CANCELLED: "user-cancelled",
  PROTOCOL_ERROR: "protocol-error",
  INTERNAL_ERROR: "internal-error",
});

/** How a session's terminal state was reached (initiator vs responder vs system). */
export const ActorType = Object.freeze({
  INITIATOR: "initiator",
  RESPONDER: "responder",
  SYSTEM: "system",
});

/**
 * @typedef {object} HandshakeSession
 * @property {string} handshakeId unique id for this handshake
 * @property {string} initiator user id that started the handshake
 * @property {string} responder user id being handshaked with
 * @property {string} initiatorDevice initiator's device id
 * @property {string} [responderDevice] responder's device id (known after ACCEPT)
 * @property {string} protocolVersion negotiated/proposed protocol version
 * @property {string} minVersion minimum acceptable version proposed by the initiator
 * @property {HandshakeState} state current lifecycle state
 * @property {string[]} proposedCapabilities capabilities the initiator advertised
 * @property {string[]} negotiatedCapabilities capabilities agreed during NEGOTIATING
 * @property {number} retryCount attempts made so far for this logical handshake
 * @property {string} [previousHandshakeId] the session this one restarted from
 * @property {FailureReason} [reason] terminal reason (failure/reject/abort)
 * @property {ActorType} [terminatedBy] who drove the terminal transition
 * @property {Array<{ from: string, to: string, at: string, reason?: string }>} history state-transition log
 * @property {object} metadata free-form public metadata (no secrets)
 * @property {string} createdAt ISO
 * @property {string} updatedAt ISO
 * @property {string} expiresAt ISO — hard deadline for the whole handshake
 * @property {string} [completedAt] ISO — set when reaching a terminal state
 */

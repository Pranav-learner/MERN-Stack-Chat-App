/**
 * @module session-integration/types
 *
 * Enums and type declarations for the **Secure Session Integration** layer (Layer 4,
 * Sprint 5). This layer makes the production chat backend *session-aware*: every
 * messaging operation is resolved + validated through a Secure Session (Sprint 3)
 * before transport.
 *
 * @security This layer establishes session AWARENESS, not encryption. It carries a
 * `secured: false` payload envelope with an unused encryption HOOK that Layer 5 fills
 * in. No message content is encrypted here.
 */

/** Stages of the message pipeline. @readonly @enum {string} */
export const PipelineStage = Object.freeze({
  RESOLVE: "resolve", // find the active session for the pair
  VALIDATE: "validate", // continuously validate the session
  PREPARE: "prepare", // build the secure payload envelope (encryption hook)
  TRANSPORT: "transport", // hand to the transport (persist + emit)
  DELIVERED: "delivered", // done
});

/** How a session lookup resolved. @readonly @enum {string} */
export const SessionResolution = Object.freeze({
  RESOLVED: "resolved", // a valid active session exists
  MISSING: "missing", // no session between the parties
  EXPIRED: "expired", // a session exists but expired
  INVALID: "invalid", // a session exists but failed validation
  HANDSHAKE_REQUIRED: "handshake-required", // parties must complete a handshake first
});

/** The transport mode selected for a message. @readonly @enum {string} */
export const TransportMode = Object.freeze({
  /** A valid Secure Session backs the message (Layer 5 will encrypt). */
  SESSION: "session",
  /** No usable session — sent in a session-less fallback (unencrypted, flagged). */
  FALLBACK: "fallback",
});

/**
 * Enforcement policy for session-awareness.
 * - `PERMISSIVE` (default) — proceed via {@link TransportMode.FALLBACK} when no valid
 *   session exists, so the app keeps working before every pair has completed a
 *   handshake. Increments a handshake-fallback counter.
 * - `STRICT` — reject a messaging operation that has no valid session
 *   ({@link SessionResolution.HANDSHAKE_REQUIRED}). Enables full enforcement once
 *   clients establish sessions.
 * @readonly @enum {string}
 */
export const EnforcementMode = Object.freeze({
  PERMISSIVE: "permissive",
  STRICT: "strict",
});

/** Integration event types. Future layers (encryption) subscribe. @readonly @enum {string} */
export const IntegrationEventType = Object.freeze({
  SESSION_RESOLVED: "integration.session_resolved",
  SESSION_MISSING: "integration.session_missing",
  SESSION_EXPIRED: "integration.session_expired",
  SESSION_VALIDATED: "integration.session_validated",
  SESSION_CREATED: "integration.session_created",
  SESSION_CLOSED: "integration.session_closed",
  SESSION_RESUMED: "integration.session_resumed",
  TRANSPORT_READY: "integration.transport_ready",
  MESSAGE_PIPELINED: "integration.message_pipelined",
  PIPELINE_FALLBACK: "integration.pipeline_fallback",
  PIPELINE_REJECTED: "integration.pipeline_rejected",
});

/** Failure modes the integration layer handles + recovers from. @readonly @enum {string} */
export const FailureMode = Object.freeze({
  MISSING_SESSION: "missing-session",
  EXPIRED_SESSION: "expired-session",
  INVALID_SESSION: "invalid-session",
  UNKNOWN_DEVICE: "unknown-device",
  REVOKED_IDENTITY: "revoked-identity",
  SESSION_MISMATCH: "session-mismatch",
  TRANSPORT_UNAVAILABLE: "transport-unavailable",
  HANDSHAKE_REQUIRED: "handshake-required",
});

/** Current secure-payload envelope version. */
export const ENVELOPE_VERSION = 1;

/**
 * @typedef {object} SessionContext The resolved session view attached to a request /
 * socket / pipeline run. PUBLIC — carries key METADATA only, never key bytes.
 * @property {string} resolution one of {@link SessionResolution}
 * @property {boolean} resolved whether a usable session backs the operation
 * @property {string} transportMode one of {@link TransportMode}
 * @property {boolean} fallback whether this is a session-less fallback
 * @property {string} [sessionId] @property {string} [handshakeId]
 * @property {string} [keyId] encryption key id (metadata; Layer 5 uses the key)
 * @property {string} [status] the session lifecycle status
 * @property {string[]} [participants]
 * @property {object[]} [warnings]
 * @property {string} initiator the acting user id
 * @property {string} peer the counterparty user id
 */

/**
 * @typedef {object} SecurePayloadEnvelope The transport envelope. `secured` is false
 * in Sprint 5; the `encryption` hook is null until Layer 5 fills it.
 * @property {number} version @property {string|null} sessionId @property {string|null} keyId
 * @property {boolean} secured always false in Layer 4
 * @property {object|null} encryption the encryption hook (null; Layer 5 populates)
 * @property {string} transportMode @property {boolean} fallback
 * @property {object} payload the message body (plaintext in Layer 4)
 * @property {object} meta
 */

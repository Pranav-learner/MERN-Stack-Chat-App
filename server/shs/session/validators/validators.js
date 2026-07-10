/**
 * @module shs/session/validators
 *
 * Validation for the Secure Session subsystem. Covers every spec item: expired
 * sessions, unknown sessions, invalid states, corrupted metadata, duplicate
 * sessions, mismatched participants, invalid session identifiers, and malformed
 * repositories. Lifecycle-transition validation lives in
 * {@link module:shs/session/lifecycle}; this module covers the rest.
 */

import { ALL_SESSION_STATES } from "../types.js";
import {
  SessionValidationError,
  SessionNotFoundError,
  SessionExpiredError,
  DuplicateSessionError,
  ParticipantMismatchError,
  CorruptedMetadataError,
} from "../errors.js";
import { isExpired } from "../expiration/expiration.js";
import { participantsKey } from "../model/secureSession.js";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Validate a session identifier's shape. @throws {SessionValidationError} */
export function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new SessionValidationError("Invalid session identifier", { details: { sessionId } });
  }
  return sessionId;
}

/** Require a session to exist. @throws {SessionNotFoundError} */
export function requireSession(session, sessionId) {
  if (!session) throw new SessionNotFoundError("Session not found", { details: { sessionId } });
  return session;
}

/** Assert a session has not passed its hard lifetime. @throws {SessionExpiredError} */
export function assertNotExpired(session, now = Date.now()) {
  if (isExpired(session, now)) {
    throw new SessionExpiredError("Session has expired", { details: { sessionId: session?.sessionId } });
  }
}

/**
 * Validate a session's stored metadata shape (detects corruption/tampering).
 * @param {object} session @throws {CorruptedMetadataError}
 */
export function validateMetadata(session) {
  if (!session || typeof session !== "object") {
    throw new CorruptedMetadataError("Session record is not an object");
  }
  for (const field of ["sessionId", "handshakeId", "status", "participants", "encryptionKey", "authenticationKey"]) {
    if (session[field] === undefined || session[field] === null) {
      throw new CorruptedMetadataError(`Session is missing "${field}"`, { details: { field } });
    }
  }
  if (!Array.isArray(session.participants) || session.participants.length === 0) {
    throw new CorruptedMetadataError("Session participants are malformed");
  }
  if (!ALL_SESSION_STATES.includes(session.status)) {
    throw new CorruptedMetadataError(`Unknown session status: ${session.status}`, { details: { status: session.status } });
  }
  // A session record must NEVER carry raw key bytes.
  if (session.encryptionKey?.bytes !== undefined || session.authenticationKey?.bytes !== undefined || "sharedSecret" in session) {
    throw new CorruptedMetadataError("Session record must not contain raw key material");
  }
  return session;
}

/**
 * Assert there is no existing ACTIVE session for a handshake (duplicate guard).
 * @param {object|null} existing an active session found for the handshake, or null
 * @throws {DuplicateSessionError}
 */
export function assertNoDuplicate(existing) {
  if (existing) {
    throw new DuplicateSessionError("An active session already exists for this handshake", {
      details: { handshakeId: existing.handshakeId, sessionId: existing.sessionId },
    });
  }
}

/**
 * Assert a caller is a participant of a session.
 * @param {object} session @param {string} userId @throws {ParticipantMismatchError}
 */
export function assertParticipant(session, userId) {
  if (!(session.participants ?? []).map(String).includes(String(userId))) {
    throw new ParticipantMismatchError("Caller is not a participant of this session", {
      details: { sessionId: session.sessionId },
    });
  }
}

/**
 * Assert two participant sets match (e.g. on resume/register).
 * @param {string[]} a @param {string[]} b @throws {ParticipantMismatchError}
 */
export function assertParticipantsMatch(a, b) {
  if (participantsKey(a) !== participantsKey(b)) {
    throw new ParticipantMismatchError("Participant sets do not match", { details: { a, b } });
  }
}

/**
 * Validate a repository implements the required contract (guards against a malformed
 * / partial repository being injected).
 * @param {object} repo @param {string[]} methods @throws {SessionValidationError}
 */
export function validateRepository(repo, methods = ["create", "findById", "update", "delete", "findActiveByHandshake", "listByUser", "findByState", "listAll"]) {
  if (!repo || typeof repo !== "object") {
    throw new SessionValidationError("Session repository is missing or malformed");
  }
  for (const m of methods) {
    if (typeof repo[m] !== "function") {
      throw new SessionValidationError(`Session repository is missing method "${m}"`, { details: { method: m } });
    }
  }
  return repo;
}

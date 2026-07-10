/**
 * @module shs/session/model
 *
 * The Secure Session record factory + pure helpers. A session record is the PUBLIC
 * container binding a handshake's derived keys to a lifecycle. It holds key METADATA
 * only (algorithm, length, keyId, fingerprint) — the raw key bytes live in the
 * device-local {@link module:shs/session/storage} secure key store.
 *
 * @security No raw key material appears in this record, so it is safe to persist to
 * the server (Mongo) and return via DTOs.
 */

import crypto from "node:crypto";
import { SessionState, SESSION_KDF } from "../types.js";

/** Default maximum session lifetime (ms). */
export const DEFAULT_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24h
/** Default idle timeout (ms). */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30m

/**
 * Build a Secure Session record in the {@link SessionState.CREATED} state.
 *
 * @param {object} params
 * @param {string} params.handshakeId
 * @param {string[]} params.participants [initiatorUserId, responderUserId]
 * @param {{ initiator?: string, responder?: string }} [params.deviceIds]
 * @param {string} [params.protocolVersion="1.0"]
 * @param {{ algorithm: string, length: number, keyId: string, fingerprint: string }} params.encryptionKeyMeta
 * @param {{ algorithm: string, length: number }} params.authenticationKeyMeta
 * @param {number} [params.maxLifetimeMs] @param {number} [params.idleTimeoutMs]
 * @param {object} [params.metadata] @param {object} [params.extensions]
 * @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 * @returns {import("../types.js").SecureSession}
 */
export function createSecureSession(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowMs = clock();
  const nowIso = new Date(nowMs).toISOString();
  const maxLifetimeMs = params.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
  const idleTimeoutMs = params.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  return {
    sessionId: params.sessionId ?? idGenerator(),
    handshakeId: String(params.handshakeId),
    participants: (params.participants ?? []).map(String),
    deviceIds: {
      initiator: params.deviceIds?.initiator ? String(params.deviceIds.initiator) : undefined,
      responder: params.deviceIds?.responder ? String(params.deviceIds.responder) : undefined,
    },
    protocolVersion: params.protocolVersion ?? "1.0",
    encryptionKey: {
      algorithm: params.encryptionKeyMeta.algorithm,
      length: params.encryptionKeyMeta.length,
      keyId: params.encryptionKeyMeta.keyId,
      fingerprint: params.encryptionKeyMeta.fingerprint,
    },
    authenticationKey: {
      algorithm: params.authenticationKeyMeta.algorithm,
      length: params.authenticationKeyMeta.length,
    },
    status: SessionState.CREATED,
    generation: params.generation ?? 0,
    rekeyHistory: [],
    createdAt: nowIso,
    lastActivityAt: nowIso,
    expiresAt: new Date(nowMs + maxLifetimeMs).toISOString(),
    maxLifetimeMs,
    idleTimeoutMs,
    security: { kdf: SESSION_KDF, contextSeparated: true, purposeSeparated: true },
    metadata: params.metadata ?? {},
    extensions: params.extensions ?? {},
    history: [{ from: null, to: SessionState.CREATED, at: nowIso }],
    updatedAt: nowIso,
  };
}

/** Whether a session is in a terminal-ish state. */
export function isSessionTerminal(session) {
  return ["closed", "destroyed", "invalid", "failed"].includes(session.status);
}

/** The two participant user ids as a set-comparable, sorted key. */
export function participantsKey(participants) {
  return [...(participants ?? [])].map(String).sort().join("::");
}

/** Whether a user id is a participant of the session. */
export function isParticipant(session, userId) {
  return (session.participants ?? []).map(String).includes(String(userId));
}

/**
 * @module shs/sessions
 *
 * The handshake session model + pure helpers. A session is the lifecycle container
 * for one handshake attempt between two users/devices. It records who, what version,
 * what capabilities, the current {@link HandshakeState}, timing, retry count, and a
 * transition history.
 *
 * @security A session holds NO shared secret and NO key material in Sprint 1. It is
 * a state record only. Future sprints attach negotiated cryptographic state to the
 * SAME record shape (additively) rather than redesigning it.
 */

import crypto from "node:crypto";
import { HandshakeState, isTerminalState, isActiveState } from "../types.js";
import { CURRENT_VERSION, MINIMUM_VERSION } from "../protocol/version.js";
import { DEFAULT_HANDSHAKE_TTL_MS } from "../protocol/constants.js";

/**
 * Build a fresh handshake session in the {@link HandshakeState.CREATED} state.
 *
 * @param {object} params
 * @param {string} params.initiator initiator user id
 * @param {string} params.responder responder user id
 * @param {string} params.initiatorDevice initiator device id
 * @param {string} [params.responderDevice] responder device id (may be unknown yet)
 * @param {string} [params.version=CURRENT_VERSION] proposed protocol version
 * @param {string} [params.minVersion=MINIMUM_VERSION] minimum acceptable version
 * @param {string[]} [params.capabilities] initiator's advertised capabilities
 * @param {object} [params.metadata] free-form public metadata (no secrets)
 * @param {number} [params.ttlMs=DEFAULT_HANDSHAKE_TTL_MS] whole-handshake lifetime
 * @param {string} [params.previousHandshakeId] the session this restarts from
 * @param {number} [params.retryCount=0]
 * @param {() => number} [params.clock]
 * @param {() => string} [params.idGenerator]
 * @returns {import("../types.js").HandshakeSession}
 */
export function createSession(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowMs = clock();
  const nowIso = new Date(nowMs).toISOString();
  const ttlMs = params.ttlMs ?? DEFAULT_HANDSHAKE_TTL_MS;

  return {
    handshakeId: idGenerator(),
    initiator: String(params.initiator),
    responder: String(params.responder),
    initiatorDevice: String(params.initiatorDevice),
    responderDevice: params.responderDevice ? String(params.responderDevice) : undefined,
    protocolVersion: params.version ?? CURRENT_VERSION,
    minVersion: params.minVersion ?? MINIMUM_VERSION,
    state: HandshakeState.CREATED,
    proposedCapabilities: params.capabilities ?? [],
    negotiatedCapabilities: [],
    retryCount: params.retryCount ?? 0,
    previousHandshakeId: params.previousHandshakeId,
    reason: undefined,
    terminatedBy: undefined,
    history: [{ from: null, to: HandshakeState.CREATED, at: nowIso }],
    metadata: params.metadata ?? {},
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    completedAt: undefined,
  };
}

/** Whether a session is in a terminal state. */
export function isSessionTerminal(session) {
  return isTerminalState(session.state);
}

/** Whether a session is still active (can progress). */
export function isSessionActive(session) {
  return isActiveState(session.state);
}

/** Whether a session can be resumed (active and not expired). */
export function isResumable(session, now = Date.now()) {
  if (!isActiveState(session.state)) return false;
  if (!session.expiresAt) return true;
  return new Date(session.expiresAt).getTime() > now;
}

/** Whether the given user is a party (initiator or responder) to the session. */
export function isParty(session, userId) {
  const id = String(userId);
  return String(session.initiator) === id || String(session.responder) === id;
}

/** The role of a user within a session, or null if they are not a party. */
export function roleOf(session, userId) {
  const id = String(userId);
  if (String(session.initiator) === id) return "initiator";
  if (String(session.responder) === id) return "responder";
  return null;
}

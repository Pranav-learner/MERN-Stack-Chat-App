/**
 * @module shs/serializers/session
 *
 * Public DTO for a handshake session. Whitelists the public lifecycle fields for
 * API responses. There is no private material in a session, so this is a shaping /
 * stabilization layer (stable field names, ISO timestamps, derived flags).
 */

import { isTerminalState, isActiveState } from "../types.js";

/**
 * @typedef {object} PublicSessionDTO
 * @property {string} handshakeId
 * @property {string} initiator
 * @property {string} responder
 * @property {string} initiatorDevice
 * @property {string} [responderDevice]
 * @property {string} protocolVersion
 * @property {string} minVersion
 * @property {string} state
 * @property {boolean} isTerminal
 * @property {boolean} isActive
 * @property {string[]} proposedCapabilities
 * @property {string[]} negotiatedCapabilities
 * @property {number} retryCount
 * @property {string} [previousHandshakeId]
 * @property {string} [reason]
 * @property {string} [terminatedBy]
 * @property {Array<object>} history
 * @property {object} metadata
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} expiresAt
 * @property {string} [completedAt]
 */

/**
 * Shape a session record into its public DTO.
 * @param {object} session
 * @param {{ role?: string }} [context] the requesting party's role, if known
 * @returns {PublicSessionDTO}
 */
export function toPublicSession(session, context = {}) {
  return {
    handshakeId: session.handshakeId,
    initiator: String(session.initiator),
    responder: String(session.responder),
    initiatorDevice: session.initiatorDevice ? String(session.initiatorDevice) : undefined,
    responderDevice: session.responderDevice ? String(session.responderDevice) : undefined,
    protocolVersion: session.protocolVersion,
    minVersion: session.minVersion,
    state: session.state,
    isTerminal: isTerminalState(session.state),
    isActive: isActiveState(session.state),
    proposedCapabilities: session.proposedCapabilities ?? [],
    negotiatedCapabilities: session.negotiatedCapabilities ?? [],
    retryCount: session.retryCount ?? 0,
    previousHandshakeId: session.previousHandshakeId,
    reason: session.reason,
    terminatedBy: session.terminatedBy,
    role: context.role,
    history: (session.history ?? []).map((h) => ({ ...h })),
    metadata: session.metadata ?? {},
    createdAt: toIso(session.createdAt),
    updatedAt: toIso(session.updatedAt),
    expiresAt: toIso(session.expiresAt),
    completedAt: toIso(session.completedAt),
  };
}

function toIso(value) {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

/**
 * @module pdp/serializers
 *
 * Public DTOs for the Peer Discovery Protocol. Whitelists PUBLIC fields for a PDP session, a
 * connection plan, and compact status/summary views. Records never contain secret material, but
 * this layer also defensively omits anything not whitelisted.
 *
 * @security The plan's `connection` + `nat` blocks are surfaced (so future-sprint consumers can
 * detect the framework is present) but are inert.
 */

import { ACTIVE_PDP_STATES, TERMINAL_PDP_STATES } from "../types/types.js";

const ACTIVE = new Set(ACTIVE_PDP_STATES);
const TERMINAL = new Set(TERMINAL_PDP_STATES);

/** Shape a selected device into its public DTO. */
export function toPublicSelectedDevice(d) {
  if (!d) return null;
  return {
    deviceId: d.deviceId,
    identityId: d.identityId ?? null,
    publicIdentity: d.publicIdentity ? { ...d.publicIdentity } : null,
    presenceStatus: d.presenceStatus,
    lastSeen: d.lastSeen ?? null,
    platform: d.platform,
    softwareVersion: d.softwareVersion,
    capabilities: d.capabilities ? { ...d.capabilities } : null,
    score: d.score,
    rank: d.rank,
    priority: d.priority,
  };
}

/**
 * Shape a connection plan into its public DTO.
 * @param {import("../types/types.js").ConnectionPlan} p @returns {object|null}
 */
export function toPublicPlan(p) {
  if (!p) return null;
  return {
    planId: p.planId,
    discoveryId: p.discoveryId,
    protocol: p.protocol,
    requester: p.requester,
    requesterDevice: p.requesterDevice,
    targetUser: p.targetUser,
    selectedDevices: (p.selectedDevices ?? []).map(toPublicSelectedDevice),
    primaryDeviceId: p.primaryDeviceId ?? null,
    presenceSnapshot: (p.presenceSnapshot ?? []).map((s) => ({ ...s })),
    negotiatedCapabilities: p.negotiatedCapabilities ? { ...p.negotiatedCapabilities } : null,
    preferredTransport: p.preferredTransport ?? null,
    fallbackTransports: [...(p.fallbackTransports ?? [])],
    protocolVersion: p.protocolVersion ?? null,
    cryptoVersion: p.cryptoVersion ?? null,
    cryptoCompatible: !!p.cryptoCompatible,
    priority: p.priority,
    selectionPolicy: p.selectionPolicy,
    connection: { ...(p.connection ?? {}) }, // FUTURE — inert
    nat: { ...(p.nat ?? {}) }, // FUTURE — inert
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    metadata: p.metadata ?? {},
    schemaVersion: p.schemaVersion,
  };
}

/**
 * Shape a PDP session into its public DTO.
 * @param {import("../types/types.js").PdpSession} s @param {{ includeAudit?: boolean }} [context]
 * @returns {object}
 */
export function toPublicSession(s, context = {}) {
  const dto = {
    discoveryId: s.discoveryId,
    requester: s.requester,
    requesterDevice: s.requesterDevice,
    targetUser: s.targetUser,
    targetDevices: [...(s.targetDevices ?? [])],
    selectionPolicy: s.selectionPolicy,
    state: s.state,
    stage: s.stage ?? null,
    planId: s.planId ?? null,
    failureReason: s.failureReason ?? null,
    attempts: s.attempts ?? 0,
    requestTime: s.requestTime,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    expiresAt: s.expiresAt,
    completedAt: s.completedAt ?? null,
    stageHistory: (s.stageHistory ?? []).map((h) => ({ ...h })),
    isActive: ACTIVE.has(s.state),
    isTerminal: TERMINAL.has(s.state),
    metadata: s.metadata ?? {},
    schemaVersion: s.schemaVersion,
  };
  if (context.includeAudit) dto.audit = (s.audit ?? []).map((a) => ({ ...a }));
  return dto;
}

/** A compact status view — just enough for a client to poll a discovery run. */
export function toPdpStatus(s) {
  return {
    discoveryId: s.discoveryId,
    targetUser: s.targetUser,
    state: s.state,
    stage: s.stage ?? null,
    isActive: ACTIVE.has(s.state),
    isTerminal: TERMINAL.has(s.state),
    planId: s.planId ?? null,
    failureReason: s.failureReason ?? null,
    attempts: s.attempts ?? 0,
    expiresAt: s.expiresAt,
    updatedAt: s.updatedAt,
  };
}

/** A compact list-item view for discovery history. */
export function toSessionListItem(s) {
  return {
    discoveryId: s.discoveryId,
    targetUser: s.targetUser,
    state: s.state,
    stage: s.stage ?? null,
    planId: s.planId ?? null,
    selectionPolicy: s.selectionPolicy,
    createdAt: s.createdAt,
    completedAt: s.completedAt ?? null,
  };
}

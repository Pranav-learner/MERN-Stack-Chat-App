/**
 * @module peer-discovery/serializers
 *
 * Public DTOs for the Peer Discovery Framework. This is the API/network guardrail: it
 * whitelists PUBLIC fields for a discovery session, a resolved metadata record, and a
 * device descriptor. Discovery records never contain secret material, but this layer also
 * defensively strips anything key-like it does not explicitly whitelist.
 *
 * @security The device/identity descriptors expose PUBLIC keys + fingerprints only. The
 * placeholders (presence/capability/transport) are surfaced so future-sprint consumers
 * can detect the framework is present, but they are inert.
 */

import {
  ACTIVE_DISCOVERY_STATES,
  TERMINAL_DISCOVERY_STATES,
  RESOLVED_DISCOVERY_STATES,
} from "../types/types.js";

const ACTIVE = new Set(ACTIVE_DISCOVERY_STATES);
const TERMINAL = new Set(TERMINAL_DISCOVERY_STATES);
const RESOLVED = new Set(RESOLVED_DISCOVERY_STATES);

/**
 * Shape a device descriptor into its public DTO (whitelist).
 * @param {import("../types/types.js").DeviceDescriptor} d
 * @returns {object}
 */
export function toPublicDeviceDescriptor(d) {
  if (!d) return null;
  return {
    userId: d.userId,
    identityId: d.identityId,
    deviceId: d.deviceId,
    publicKey: d.publicKey, // PUBLIC device key only
    algorithm: d.algorithm,
    fingerprint: d.fingerprint,
    name: d.name,
    platform: d.platform,
    status: d.status,
    // FUTURE placeholders — surfaced but inert.
    presence: { ...(d.presence ?? {}) },
    capabilities: { ...(d.capabilities ?? {}) },
    transport: { ...(d.transport ?? {}) },
    version: d.version,
    registeredAt: d.registeredAt,
    updatedAt: d.updatedAt,
    metadata: d.metadata ?? {},
  };
}

/**
 * Shape resolved discovery metadata into its public DTO.
 * @param {import("../types/types.js").DiscoveryMetadata} m
 * @returns {object|null}
 */
export function toPublicDiscoveryMetadata(m) {
  if (!m) return null;
  return {
    userId: m.userId,
    identityId: m.identityId ?? null,
    publicIdentity: m.publicIdentity ? { ...m.publicIdentity } : null,
    deviceIds: [...(m.deviceIds ?? [])],
    devices: (m.devices ?? []).map(toPublicDeviceDescriptor),
    presence: { ...(m.presence ?? {}) },
    capabilities: { ...(m.capabilities ?? {}) },
    transport: { ...(m.transport ?? {}) },
    version: m.version,
    source: m.source,
    resolvedAt: m.resolvedAt,
    schemaVersion: m.schemaVersion,
    metadata: m.metadata ?? {},
  };
}

/**
 * Shape a discovery session into its public DTO.
 * @param {import("../types/types.js").DiscoverySession} s
 * @param {{ includeAudit?: boolean }} [context]
 * @returns {object}
 */
export function toPublicDiscoverySession(s, context = {}) {
  const dto = {
    discoveryId: s.discoveryId,
    requester: s.requester,
    requesterDevice: s.requesterDevice,
    targetUser: s.targetUser,
    targetDevices: [...(s.targetDevices ?? [])],
    lookupType: s.lookupType,
    state: s.state,
    requestTime: s.requestTime,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    expiresAt: s.expiresAt,
    resolvedAt: s.resolvedAt ?? null,
    completedAt: s.completedAt ?? null,
    result: toPublicDiscoveryMetadata(s.result),
    capabilitiesSnapshot: { ...(s.capabilitiesSnapshot ?? {}) },
    failureReason: s.failureReason ?? null,
    metadata: s.metadata ?? {},
    schemaVersion: s.schemaVersion,
    isActive: ACTIVE.has(s.state),
    isTerminal: TERMINAL.has(s.state),
    isResolved: RESOLVED.has(s.state),
  };
  if (context.includeAudit) dto.audit = (s.audit ?? []).map((a) => ({ ...a }));
  return dto;
}

/**
 * A compact status view — just enough for a client to poll a lookup.
 * @param {import("../types/types.js").DiscoverySession} s
 * @returns {object}
 */
export function toDiscoveryStatus(s) {
  return {
    discoveryId: s.discoveryId,
    targetUser: s.targetUser,
    lookupType: s.lookupType,
    state: s.state,
    isActive: ACTIVE.has(s.state),
    isResolved: RESOLVED.has(s.state),
    isTerminal: TERMINAL.has(s.state),
    deviceCount: s.result?.devices?.length ?? 0,
    failureReason: s.failureReason ?? null,
    expiresAt: s.expiresAt,
    updatedAt: s.updatedAt,
  };
}

/**
 * A compact list-item view for "list active discoveries".
 * @param {import("../types/types.js").DiscoverySession} s @returns {object}
 */
export function toDiscoveryListItem(s) {
  return {
    discoveryId: s.discoveryId,
    targetUser: s.targetUser,
    lookupType: s.lookupType,
    state: s.state,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    deviceCount: s.result?.devices?.length ?? 0,
  };
}

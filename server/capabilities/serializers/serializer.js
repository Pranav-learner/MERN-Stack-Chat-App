/**
 * @module capabilities/serializers
 *
 * Public DTOs for the Capability Exchange subsystem. Whitelists PUBLIC fields for a capability
 * set, a negotiation result, and compact status/negotiation-history views. Capability records
 * never contain secret material, but this layer also defensively omits anything not whitelisted.
 *
 * @security The `transport` block on a negotiation result and the `p2p` block on a capability set
 * are surfaced (so future-sprint consumers can detect the framework is present) but are inert.
 */

import { isNegotiableState } from "../types/types.js";

/**
 * Shape a capability set into its public DTO (whitelist).
 * @param {import("../types/types.js").CapabilitySet} c
 * @param {{ includeHistory?: boolean }} [context] @returns {object|null}
 */
export function toPublicCapabilities(c, context = {}) {
  if (!c) return null;
  const dto = {
    capabilityId: c.capabilityId,
    userId: c.userId,
    identityId: c.identityId ?? null,
    deviceId: c.deviceId,
    protocolVersions: [...(c.protocolVersions ?? [])],
    cryptoVersions: [...(c.cryptoVersions ?? [])],
    transports: [...(c.transports ?? [])],
    compression: [...(c.compression ?? [])],
    attachments: { ...(c.attachments ?? {}) },
    maxPayloadSize: c.maxPayloadSize,
    relaySupport: c.relaySupport,
    p2p: { ...(c.p2p ?? {}) }, // FUTURE — inert
    connectionPreferences: [...(c.connectionPreferences ?? [])],
    platformFeatures: [...(c.platformFeatures ?? [])],
    softwareVersion: c.softwareVersion,
    featureFlags: { ...(c.featureFlags ?? {}) },
    state: c.state,
    negotiable: isNegotiableState(c.state),
    version: c.version,
    registeredAt: c.registeredAt,
    updatedAt: c.updatedAt,
    expiresAt: c.expiresAt,
    metadata: c.metadata ?? {},
    schemaVersion: c.schemaVersion,
  };
  if (context.includeHistory) dto.versionHistory = (c.versionHistory ?? []).map((h) => ({ ...h }));
  return dto;
}

/**
 * Shape a negotiation result into its public DTO.
 * @param {import("../types/types.js").NegotiationResult} r @returns {object|null}
 */
export function toPublicNegotiation(r) {
  if (!r) return null;
  return {
    compatible: r.compatible,
    protocolVersion: r.protocolVersion ?? null,
    cryptoVersion: r.cryptoVersion ?? null,
    compression: r.compression,
    attachments: { ...(r.attachments ?? {}) },
    maxPayloadSize: r.maxPayloadSize,
    sharedTransports: [...(r.sharedTransports ?? [])],
    preferredTransport: r.preferredTransport ?? null,
    fallbackChain: [...(r.fallbackChain ?? [])],
    featureFlags: { ...(r.featureFlags ?? {}) },
    relay: r.relay,
    policy: r.policy,
    failureReason: r.failureReason ?? null,
    transport: { ...(r.transport ?? {}) }, // FUTURE — inert
    schemaVersion: r.schemaVersion,
  };
}

/**
 * A compact capability-status view (for polling / lists).
 * @param {import("../types/types.js").CapabilitySet} c @returns {object}
 */
export function toCapabilityStatus(c) {
  return {
    capabilityId: c.capabilityId,
    userId: c.userId,
    deviceId: c.deviceId,
    state: c.state,
    negotiable: isNegotiableState(c.state),
    version: c.version,
    protocolVersions: [...(c.protocolVersions ?? [])],
    transports: [...(c.transports ?? [])],
    expiresAt: c.expiresAt,
    updatedAt: c.updatedAt,
  };
}

/**
 * Shape a stored negotiation record into its public DTO (result + who/when).
 * @param {object} n @returns {object|null}
 */
export function toPublicNegotiationRecord(n) {
  if (!n) return null;
  return {
    negotiationId: n.negotiationId,
    requester: n.requester,
    requesterDevice: n.requesterDevice,
    targetUser: n.targetUser,
    targetDevice: n.targetDevice,
    state: n.state,
    result: toPublicNegotiation(n.result),
    createdAt: n.createdAt,
    schemaVersion: n.schemaVersion,
  };
}

/**
 * @module endpoint-selection/serializers
 *
 * Public DTOs for the Endpoint Selection subsystem. Whitelists PUBLIC fields for a connection plan,
 * an endpoint, a scored/ranked endpoint, and compact status views. Records never contain secret
 * material, but this layer also defensively omits anything not whitelisted.
 *
 * @security The plan's `nat` block is surfaced (so future-sprint consumers can detect the framework
 * is present) but is inert.
 */

import { PlanStatus } from "../types/types.js";

/** Shape a plan endpoint into its public DTO. */
export function toPublicEndpoint(e) {
  if (!e) return null;
  return {
    deviceId: e.deviceId,
    identityId: e.identityId ?? null,
    publicIdentity: e.publicIdentity ? { ...e.publicIdentity } : null,
    presenceStatus: e.presenceStatus,
    lastSeen: e.lastSeen ?? null,
    platform: e.platform,
    deviceType: e.deviceType,
    softwareVersion: e.softwareVersion,
    capabilities: e.capabilities ? { ...e.capabilities } : null,
    preferredTransport: e.preferredTransport ?? null,
    score: e.score,
    breakdown: { ...(e.breakdown ?? {}) },
    rank: e.rank,
    priority: e.priority,
    eligible: e.eligible,
  };
}

/** Shape a scored/ranked endpoint (from the scorer) into its public DTO. */
export function toPublicRanked(s) {
  if (!s) return null;
  return {
    deviceId: s.deviceId,
    score: s.score,
    rank: s.rank,
    breakdown: { ...(s.breakdown ?? {}) },
    eligible: s.eligible,
    ineligibleReason: s.ineligibleReason ?? null,
    presenceStatus: s.candidate?.presenceStatus,
    platform: s.candidate?.platform,
  };
}

/**
 * Shape an endpoint connection plan into its public DTO.
 * @param {import("../types/types.js").EndpointConnectionPlan} p @returns {object|null}
 */
export function toPublicPlan(p) {
  if (!p) return null;
  return {
    planId: p.planId,
    framework: p.framework,
    requester: p.requester,
    requesterDevice: p.requesterDevice,
    targetUser: p.targetUser,
    status: p.status,
    primaryEndpoint: toPublicEndpoint(p.primaryEndpoint),
    fallbackEndpoints: (p.fallbackEndpoints ?? []).map(toPublicEndpoint),
    priorityOrder: [...(p.priorityOrder ?? [])],
    selectionReason: p.selectionReason,
    negotiatedCapabilities: p.negotiatedCapabilities ? { ...p.negotiatedCapabilities } : null,
    preferredTransport: p.preferredTransport ?? null,
    fallbackTransports: [...(p.fallbackTransports ?? [])],
    retryStrategy: { ...(p.retryStrategy ?? {}) },
    selectionPolicy: p.selectionPolicy,
    weights: { ...(p.weights ?? {}) },
    nat: { ...(p.nat ?? {}) }, // FUTURE — inert
    priority: p.priority,
    generation: p.generation,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    expiresAt: p.expiresAt,
    metadata: p.metadata ?? {},
    schemaVersion: p.schemaVersion,
  };
}

/** A compact plan status view (for polling / lists). */
export function toPlanStatus(p) {
  return {
    planId: p.planId,
    targetUser: p.targetUser,
    status: p.status,
    active: p.status === PlanStatus.ACTIVE || p.status === PlanStatus.FAILED_OVER,
    primaryDeviceId: p.primaryEndpoint?.deviceId ?? null,
    fallbackCount: (p.fallbackEndpoints ?? []).length,
    preferredTransport: p.preferredTransport ?? null,
    generation: p.generation,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    expiresAt: p.expiresAt,
  };
}

/** A compact list-item view for routing/selection history. */
export function toPlanListItem(p) {
  return {
    planId: p.planId,
    targetUser: p.targetUser,
    status: p.status,
    primaryDeviceId: p.primaryEndpoint?.deviceId ?? null,
    selectionPolicy: p.selectionPolicy,
    generation: p.generation,
    createdAt: p.createdAt,
  };
}

/**
 * @module network-discovery/serializers
 *
 * Public DTOs for the Network Discovery subsystem. Whitelists PUBLIC fields for a network profile,
 * a candidate, and compact NAT / interface / diagnostics views. Profiles never contain secret
 * material; this layer also defensively omits anything not whitelisted.
 */

/** Shape a candidate into its public DTO. */
export function toPublicCandidate(c) {
  if (!c) return null;
  return {
    candidateId: c.candidateId,
    foundation: c.foundation,
    component: c.component,
    transport: c.transport,
    priority: c.priority,
    type: c.type,
    ip: c.ip,
    port: c.port,
    family: c.family,
    relatedAddress: c.relatedAddress ?? null,
    relatedPort: c.relatedPort ?? null,
    sdp: c.sdp,
    metadata: c.metadata ?? {},
    gatheredAt: c.gatheredAt,
    expiresAt: c.expiresAt,
  };
}

/** Shape a network profile into its public DTO. */
export function toPublicProfile(profile, context = {}) {
  if (!profile) return null;
  const dto = {
    profileId: profile.profileId,
    framework: profile.framework,
    deviceId: profile.deviceId,
    userId: profile.userId ?? null,
    state: profile.state,
    privateAddresses: [...(profile.privateAddresses ?? [])],
    publicAddress: profile.publicAddress ?? null,
    privatePorts: [...(profile.privatePorts ?? [])],
    publicPorts: [...(profile.publicPorts ?? [])],
    natType: profile.natType,
    interfaces: (profile.interfaces ?? []).map((i) => ({ ...i })),
    connectionMetadata: { ...(profile.connectionMetadata ?? {}) },
    nat: { ...(profile.nat ?? {}) },
    diagnostics: { ...(profile.diagnostics ?? {}) },
    discoveredAt: profile.discoveredAt,
    updatedAt: profile.updatedAt,
    expiresAt: profile.expiresAt,
    version: profile.version,
    schemaVersion: profile.schemaVersion,
  };
  if (context.includeCandidates !== false) dto.candidates = (profile.candidates ?? []).map(toPublicCandidate);
  return dto;
}

/** A compact profile summary (for lists / polling). */
export function toProfileSummary(profile) {
  return {
    profileId: profile.profileId,
    deviceId: profile.deviceId,
    state: profile.state,
    natType: profile.natType,
    publicAddress: profile.publicAddress ?? null,
    candidateCount: (profile.candidates ?? []).length,
    discoveredAt: profile.discoveredAt,
    expiresAt: profile.expiresAt,
    version: profile.version,
  };
}

/** A NAT-info view. */
export function toNatInfo(profile) {
  return {
    deviceId: profile.deviceId,
    natType: profile.natType,
    symmetric: !!profile.nat?.symmetric,
    publicAddress: profile.publicAddress ?? null,
    portMapping: { ...(profile.nat?.portMapping ?? {}) },
    reachability: { ...(profile.nat?.reachability ?? {}) },
  };
}

/** A public-address view. */
export function toPublicAddress(profile) {
  return {
    deviceId: profile.deviceId,
    publicAddress: profile.publicAddress ?? null,
    publicPorts: [...(profile.publicPorts ?? [])],
    natType: profile.natType,
  };
}

/** A diagnostics view. */
export function toDiagnostics(profile) {
  return {
    deviceId: profile.deviceId,
    profileId: profile.profileId,
    natType: profile.natType,
    diagnostics: { ...(profile.diagnostics ?? {}) },
    interfaceCount: (profile.interfaces ?? []).length,
    candidateCount: (profile.candidates ?? []).length,
  };
}

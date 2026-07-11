/**
 * @module network-discovery/profile
 *
 * The **Network Profile** factory — assembles a device's discovered network environment into one
 * reusable, PUBLIC record: its private + public addresses/ports, detected NAT type, interfaces,
 * gathered candidates, connection metadata, diagnostics, and an expiration. This is the primary
 * output a FUTURE ICE/TURN/WebRTC sprint consumes.
 *
 * @security A profile contains PUBLIC addressing metadata ONLY — never a private key, session key,
 * message key, chain key, or shared secret. Addresses are sensitive but not cryptographic secrets;
 * the no-secret invariant is still enforced before storage.
 */

import crypto from "node:crypto";
import {
  ProfileState,
  NatType,
  NETDISC_SCHEMA_VERSION,
  NETDISC_FRAMEWORK,
  DEFAULT_PROFILE_TTL_MS,
} from "../types/types.js";
import { usableInterfaces } from "../interfaces/interfaces.js";

/**
 * Assemble a {@link NetworkProfile}.
 *
 * @param {object} params
 * @param {string} params.deviceId @param {string} [params.userId]
 * @param {import("../types/types.js").NetworkInterfaceDescriptor[]} params.interfaces
 * @param {import("../types/types.js").ConnectionCandidate[]} params.candidates
 * @param {object} params.nat the NAT classification (from {@link module:network-discovery/nat})
 * @param {object} [params.diagnostics] @param {object} [params.connectionMetadata]
 * @param {string} [params.state] @param {number} [params.ttlMs] @param {number} [params.version]
 * @param {string} [params.profileId] @param {Function} [params.clock] @param {Function} [params.idGenerator]
 * @returns {import("../types/types.js").NetworkProfile}
 */
export function createNetworkProfile(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowMs = clock();
  const nowIso = new Date(nowMs).toISOString();
  const ttlMs = params.ttlMs ?? DEFAULT_PROFILE_TTL_MS;
  const interfaces = params.interfaces ?? [];
  const candidates = params.candidates ?? [];
  const usable = usableInterfaces(interfaces);

  const privateAddresses = [...new Set(usable.map((i) => i.address))];
  const privatePorts = [...new Set(candidates.filter((c) => c.type === "host").map((c) => c.port).filter((p) => p > 0))];
  const publicAddress = params.nat?.publicAddress ?? null;
  const publicPorts = [...new Set(candidates.filter((c) => c.type === "srflx").map((c) => c.port).filter((p) => p > 0))];

  return {
    profileId: params.profileId ?? idGenerator(),
    framework: NETDISC_FRAMEWORK,
    deviceId: String(params.deviceId),
    userId: params.userId != null ? String(params.userId) : null,
    state: params.state ?? ProfileState.READY,
    privateAddresses,
    publicAddress,
    privatePorts,
    publicPorts,
    natType: params.nat?.natType ?? NatType.UNKNOWN,
    interfaces: interfaces.map((i) => ({ ...i })),
    candidates: candidates.map((c) => ({ ...c })),
    connectionMetadata: {
      hostCandidateCount: candidates.filter((c) => c.type === "host").length,
      srflxCandidateCount: candidates.filter((c) => c.type === "srflx").length,
      relayCandidateCount: 0, // FUTURE — TURN
      symmetric: !!params.nat?.symmetric,
      ...(params.connectionMetadata ?? {}),
    },
    nat: {
      type: params.nat?.natType ?? NatType.UNKNOWN,
      symmetric: !!params.nat?.symmetric,
      portMapping: params.nat?.portMapping ?? {},
      reachability: params.nat?.reachability ?? {},
    },
    diagnostics: { ...(params.nat?.diagnostics ?? {}), ...(params.diagnostics ?? {}) },
    discoveredAt: nowIso,
    updatedAt: nowIso,
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    version: params.version ?? 1,
    schemaVersion: NETDISC_SCHEMA_VERSION,
  };
}

/** Whether a profile has passed its expiration instant. */
export function isProfileExpired(profile, now = Date.now()) {
  if (!profile?.expiresAt) return false;
  return new Date(profile.expiresAt).getTime() <= now;
}

/**
 * A signature of a profile's networking-relevant fields, so a refresh can detect a NETWORK CHANGE
 * (different addresses/NAT) vs an unchanged refresh.
 * @param {object} profile @returns {string}
 */
export function networkSignature(profile) {
  const priv = [...(profile?.privateAddresses ?? [])].sort().join(",");
  const pub = profile?.publicAddress ?? "";
  return `${priv}|${pub}|${profile?.natType ?? ""}`;
}

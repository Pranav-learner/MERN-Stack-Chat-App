/**
 * @module presence/advertisement
 *
 * **Device Advertisement** builders. When a device is present, it publishes a PUBLIC
 * advertisement — the answer to *"who is here, and how do you recognize them?"*. It carries
 * the device's public identity, its presence status, and descriptive metadata (software
 * version, platform). It deliberately does NOT carry any way to *reach* the device — the
 * `connection` and `transport` blocks are inert placeholders that FUTURE Layer 6 sprints
 * (Capability Exchange, then NAT Traversal / ICE / WebRTC) populate.
 *
 * @security An advertisement is PUBLIC. It carries a device/identity PUBLIC key + fingerprint
 * only — never a private key, session key, message key, chain key, or shared secret. The
 * no-secret invariant is enforced by {@link module:presence/validators.assertNoSecretMaterial}
 * before an advertisement is stored or returned.
 */

import { PRESENCE_SCHEMA_VERSION, PresenceStatus } from "../types/types.js";

/**
 * FUTURE placeholder — connection-metadata block (Layer 6 · Capability Exchange sprint). Inert
 * in Sprint 2; presence never advertises HOW a device can be reached.
 * @returns {object}
 */
export function createConnectionPlaceholder() {
  return {
    enabled: false,
    endpoints: null, // future: reachable endpoints / signaling hints
    protocols: null, // future: supported connection protocols
    reserved: true,
  };
}

/**
 * FUTURE placeholder — transport block (Layer 6 · NAT Traversal / ICE / WebRTC sprints). Inert
 * in Sprint 2; presence never advertises reachability (candidates, relays, ports).
 * @returns {object}
 */
export function createTransportPlaceholder() {
  return {
    enabled: false,
    candidates: null, // future: ICE candidates
    relays: null, // future: TURN relays
    reachability: null, // future
    reserved: true,
  };
}

/**
 * Build a PUBLIC identity descriptor from a raw identity record. Carries the PUBLIC key only.
 * @param {object|null} identity @returns {import("../types/types.js").PublicIdentityDescriptor|null}
 */
export function createPublicIdentity(identity) {
  if (!identity) return null;
  return {
    identityId: identity.identityId != null ? String(identity.identityId) : null,
    publicKey: identity.publicKey, // PUBLIC key only
    algorithm: identity.algorithm ?? "ed25519",
    fingerprint: identity.fingerprint,
    version: Number.isInteger(identity.version) ? identity.version : 1,
  };
}

/**
 * Build a PUBLIC {@link DeviceAdvertisement} for a reachable device. Whitelists public fields;
 * the connection/transport blocks are inert placeholders.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.deviceId
 * @param {string} [params.identityId]
 * @param {object|null} [params.identity] a raw PUBLIC identity record (→ publicIdentity)
 * @param {string} [params.status] one of {@link PresenceStatus}
 * @param {string} [params.softwareVersion]
 * @param {string} [params.platform]
 * @param {number} [params.version] advertisement version counter
 * @param {string} [params.at] ISO timestamp
 * @param {object} [params.metadata] free-form PUBLIC metadata
 * @returns {import("../types/types.js").DeviceAdvertisement}
 */
export function createDeviceAdvertisement(params) {
  const publicIdentity = createPublicIdentity(params.identity ?? null);
  return {
    userId: String(params.userId),
    identityId: params.identityId != null ? String(params.identityId) : publicIdentity?.identityId ?? null,
    deviceId: String(params.deviceId),
    publicIdentity,
    status: params.status ?? PresenceStatus.ONLINE,
    softwareVersion: params.softwareVersion,
    platform: params.platform,
    connection: createConnectionPlaceholder(), // FUTURE — inert
    transport: createTransportPlaceholder(), // FUTURE — inert
    version: Number.isInteger(params.version) ? params.version : 1,
    advertisedAt: params.at ?? new Date().toISOString(),
    metadata: params.metadata ?? {},
    schemaVersion: PRESENCE_SCHEMA_VERSION,
  };
}

/**
 * Re-stamp an advertisement with a new status + timestamp (bumping its version). Used when a
 * device's presence status changes but its identity/descriptive fields do not.
 * @param {import("../types/types.js").DeviceAdvertisement} advertisement
 * @param {string} status @param {string} at ISO timestamp
 * @returns {import("../types/types.js").DeviceAdvertisement}
 */
export function restampAdvertisement(advertisement, status, at) {
  if (!advertisement) return advertisement;
  return { ...advertisement, status, advertisedAt: at, version: (advertisement.version ?? 1) + 1 };
}

/**
 * @module peer-discovery/metadata
 *
 * The **Discovery Metadata** framework. Discovery answers *who a peer is and which
 * devices they have*. This module builds the PUBLIC descriptors that answer carries:
 *
 * - **DeviceDescriptor** — one discoverable device (public device key + fingerprint +
 *   status), the registry's unit of storage.
 * - **DiscoveryMetadata** — a user's resolved discovery record: their public identity,
 *   their discoverable devices, and inert placeholders for presence / capability /
 *   transport that FUTURE Layer 6 sprints populate.
 * - **presence / capability / transport placeholders** — the extension points for the
 *   Presence, Capability Exchange, and NAT Traversal sprints. Inert here.
 * - **audit** — an append-only trail of notable discovery actions.
 *
 * @security Metadata blocks hold PUBLIC descriptors ONLY. A device/identity descriptor
 * carries a device/identity PUBLIC key — never a private key, session key, message key,
 * chain key, or shared secret. The no-secret invariant is enforced by
 * {@link module:peer-discovery/validators.assertNoSecretMaterial}.
 */

import {
  DISCOVERY_FRAMEWORK,
  DISCOVERY_SCHEMA_VERSION,
  DiscoverySource,
  RegistryStatus,
} from "../types/types.js";

/**
 * FUTURE placeholder — presence block (Layer 6 · Presence sprint). Inert in Sprint 1;
 * discovery never reports whether a peer is online.
 * @returns {object}
 */
export function createPresencePlaceholder() {
  return {
    enabled: false,
    status: null, // future: "online" | "offline" | "away" | ...
    lastSeen: null, // future: ISO timestamp
    reserved: true,
  };
}

/**
 * FUTURE placeholder — capability block (Layer 6 · Capability Exchange sprint). Inert in
 * Sprint 1; discovery never negotiates features.
 * @returns {object}
 */
export function createCapabilityPlaceholder() {
  return {
    enabled: false,
    features: null, // future: string[]
    protocolVersions: null, // future
    reserved: true,
  };
}

/**
 * FUTURE placeholder — transport block (Layer 6 · NAT Traversal / ICE / WebRTC sprints).
 * Inert in Sprint 1; discovery never advertises reachability (candidates, relays, ports).
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
 * Build a PUBLIC discoverable device descriptor from a raw device record. Whitelists
 * public fields; the presence/capability/transport blocks are inert placeholders.
 *
 * @param {object} device a raw device record (from the registry or the directory)
 * @param {{ now?: string }} [options]
 * @returns {import("../types/types.js").DeviceDescriptor}
 */
export function createDeviceDescriptor(device, options = {}) {
  const now = options.now ?? new Date().toISOString();
  return {
    userId: String(device.userId),
    identityId: device.identityId != null ? String(device.identityId) : undefined,
    deviceId: String(device.deviceId),
    publicKey: device.publicKey, // PUBLIC device key only
    algorithm: device.algorithm ?? "ed25519",
    fingerprint: device.fingerprint,
    name: device.name,
    platform: device.platform,
    status: normalizeStatus(device),
    presence: createPresencePlaceholder(),
    capabilities: createCapabilityPlaceholder(),
    transport: createTransportPlaceholder(),
    version: Number.isInteger(device.version) ? device.version : 1,
    registeredAt: device.registeredAt ?? now,
    updatedAt: device.updatedAt ?? now,
    metadata: device.metadata ?? {},
  };
}

/**
 * Build a PUBLIC identity descriptor from a raw identity record. Carries the identity's
 * PUBLIC key only.
 * @param {object} identity a raw identity record
 * @returns {import("../types/types.js").PublicIdentityDescriptor|null}
 */
export function createIdentityDescriptor(identity) {
  if (!identity) return null;
  return {
    identityId: String(identity.identityId),
    publicKey: identity.publicKey, // PUBLIC identity key only
    algorithm: identity.algorithm ?? "ed25519",
    fingerprint: identity.fingerprint,
    version: Number.isInteger(identity.version) ? identity.version : 1,
  };
}

/**
 * Assemble a user's resolved {@link DiscoveryMetadata} from a public identity descriptor
 * and a set of device descriptors. This is the "Resolve Discovery Metadata" output.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {import("../types/types.js").PublicIdentityDescriptor|null} [params.identity]
 * @param {import("../types/types.js").DeviceDescriptor[]} [params.devices]
 * @param {string} [params.source] one of {@link DiscoverySource}
 * @param {string} [params.at] ISO timestamp
 * @param {object} [params.metadata]
 * @returns {import("../types/types.js").DiscoveryMetadata}
 */
export function createDiscoveryMetadata(params) {
  const devices = (params.devices ?? []).map((d) => ({ ...d }));
  const at = params.at ?? new Date().toISOString();
  return {
    userId: String(params.userId),
    identityId: params.identity?.identityId ?? null,
    publicIdentity: params.identity ? { ...params.identity } : null,
    deviceIds: devices.map((d) => d.deviceId),
    devices,
    presence: createPresencePlaceholder(),
    capabilities: createCapabilityPlaceholder(),
    transport: createTransportPlaceholder(),
    version: 1,
    source: params.source ?? DiscoverySource.REGISTRY,
    resolvedAt: at,
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    metadata: params.metadata ?? {},
  };
}

/**
 * A single audit entry (append-only). Public + non-secret.
 * @param {string} action @param {{ at?: string, actor?: string, reason?: string, source?: string, deviceCount?: number, details?: object }} [meta]
 * @returns {object}
 */
export function createAuditEntry(action, meta = {}) {
  const entry = { action, at: meta.at ?? new Date().toISOString() };
  if (meta.actor !== undefined) entry.actor = meta.actor;
  if (meta.reason !== undefined) entry.reason = meta.reason;
  if (meta.source !== undefined) entry.source = meta.source;
  if (meta.deviceCount !== undefined) entry.deviceCount = meta.deviceCount;
  if (meta.details !== undefined) entry.details = meta.details;
  return entry;
}

/**
 * Append an audit entry immutably (returns a new array; caps length to avoid unbounded
 * growth). @param {object[]} audit @param {object} entry @param {number} [max=100]
 * @returns {object[]}
 */
export function appendAudit(audit, entry, max = 100) {
  const next = [...(audit ?? []), entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * FUTURE placeholder — the capability snapshot captured on a discovery session. Inert in
 * Sprint 1; recorded so future Capability Exchange can reason about what was known at
 * lookup time.
 * @param {object} [overrides]
 * @returns {object}
 */
export function createCapabilitiesSnapshot(overrides = {}) {
  return {
    framework: DISCOVERY_FRAMEWORK,
    version: DISCOVERY_SCHEMA_VERSION,
    presenceAvailable: false, // Layer 6 · Presence sprint
    capabilityExchange: false, // Layer 6 · Capability Exchange sprint
    natTraversal: false, // Layer 6 · NAT Traversal sprint
    transportNegotiation: false, // future
    ...overrides,
  };
}

/** Normalize a raw device record's status into a {@link RegistryStatus}. */
function normalizeStatus(device) {
  if (device.status && Object.values(RegistryStatus).includes(device.status)) return device.status;
  // Map identity/device-trust states onto registry discoverability.
  const trust = device.trustStatus;
  if (trust === "revoked" || trust === "blocked") return RegistryStatus.REVOKED;
  if (trust === "inactive" || trust === "expired" || trust === "pending") return RegistryStatus.INACTIVE;
  if (device.status === "revoked") return RegistryStatus.REVOKED;
  return RegistryStatus.ACTIVE;
}

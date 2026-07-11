/**
 * @module peer-discovery/types
 *
 * Enums and type declarations for the **Peer Discovery Framework** — Layer 6, Sprint 1.
 * This sprint builds the reusable networking CONTROL PLANE that answers a single
 * question: *"How do devices discover each other?"* It creates discovery sessions, a
 * device/user registry, a metadata resolver, a deterministic state machine, caching,
 * validation, events, repositories, and an API surface.
 *
 * @security This sprint exposes ONLY public discovery metadata — user ids, identity ids,
 * device ids, public identity keys (Ed25519 PUBLIC keys + fingerprints), and inert
 * placeholders for presence/capability/transport. It NEVER exposes private keys, session
 * keys, message keys, chain keys, or shared secrets. See {@link module:peer-discovery/validators}
 * for the enforced no-secret invariant.
 *
 * @evolution The framework is transport-INDEPENDENT. Discovery answers *who a peer is
 * and which devices they have*; it does NOT negotiate *how to reach them*. Future Layer 6
 * sprints (Presence, Capability Exchange, NAT Traversal, ICE/STUN/TURN, WebRTC, QUIC,
 * TCP, P2P) consume this control plane instead of redesigning it — the presence,
 * capability, and transport placeholders are the extension points they populate.
 */

/**
 * Discovery-session lifecycle states. A discovery session is a deterministic finite
 * state machine over these (see {@link module:peer-discovery/lifecycle}).
 *
 * - `CREATED`   — session record created; not yet queued.
 * - `PENDING`   — accepted + queued; awaiting the resolver.
 * - `SEARCHING` — the resolver is actively looking the peer/devices up.
 * - `RESOLVED`  — discovery metadata was found; result attached.
 * - `FAILED`    — resolution failed (unknown user/device, corruption, error). Terminal.
 * - `EXPIRED`   — the session outlived its TTL before completing. Terminal.
 * - `CANCELLED` — the requester cancelled the lookup. Terminal.
 * - `COMPLETED` — a resolved result was consumed/acknowledged by the caller. Terminal.
 * @readonly @enum {string}
 */
export const DiscoveryState = Object.freeze({
  CREATED: "created",
  PENDING: "pending",
  SEARCHING: "searching",
  RESOLVED: "resolved",
  FAILED: "failed",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
  COMPLETED: "completed",
});

/** All discovery states, in canonical order. */
export const ALL_DISCOVERY_STATES = Object.freeze(Object.values(DiscoveryState));

/** States in which a discovery session is still live / can still progress. */
export const ACTIVE_DISCOVERY_STATES = Object.freeze([
  DiscoveryState.CREATED,
  DiscoveryState.PENDING,
  DiscoveryState.SEARCHING,
  DiscoveryState.RESOLVED,
]);

/** States from which a discovery session cannot progress further. */
export const TERMINAL_DISCOVERY_STATES = Object.freeze([
  DiscoveryState.FAILED,
  DiscoveryState.EXPIRED,
  DiscoveryState.CANCELLED,
  DiscoveryState.COMPLETED,
]);

/** States that count as a successful resolution. */
export const RESOLVED_DISCOVERY_STATES = Object.freeze([
  DiscoveryState.RESOLVED,
  DiscoveryState.COMPLETED,
]);

/** Whether a state is terminal. @param {string} state @returns {boolean} */
export function isTerminalDiscoveryState(state) {
  return TERMINAL_DISCOVERY_STATES.includes(state);
}

/** Whether a state is live / still trackable. @param {string} state @returns {boolean} */
export function isActiveDiscoveryState(state) {
  return ACTIVE_DISCOVERY_STATES.includes(state);
}

/** Whether a state represents a found peer. @param {string} state @returns {boolean} */
export function isResolvedDiscoveryState(state) {
  return RESOLVED_DISCOVERY_STATES.includes(state);
}

/**
 * The kind of lookup a discovery session performs. Describes WHAT is being discovered,
 * never HOW it will be reached (transport negotiation is a future sprint).
 * @readonly @enum {string}
 */
export const LookupType = Object.freeze({
  USER: "user", // resolve a user → their identity + all discoverable devices
  DEVICE: "device", // resolve a single device by (userId, deviceId)
  DEVICES: "devices", // resolve a specific subset of a user's devices
});

/** All known lookup types. */
export const ALL_LOOKUP_TYPES = Object.freeze(Object.values(LookupType));

/**
 * Where a resolved discovery result came from — recorded for observability + so future
 * transports can reason about freshness.
 * @readonly @enum {string}
 */
export const DiscoverySource = Object.freeze({
  CACHE: "cache", // served from the discovery cache (fast path)
  REGISTRY: "registry", // resolved from the discovery registry
  DIRECTORY: "directory", // hydrated from the authoritative identity/device directory
  NEGATIVE_CACHE: "negative-cache", // a cached "not found"
});

/**
 * Outcome of a discovery-cache probe.
 * @readonly @enum {string}
 */
export const CacheOutcome = Object.freeze({
  HIT: "hit", // fresh positive entry
  MISS: "miss", // no entry
  NEGATIVE: "negative", // cached "not found" (fresh)
  EXPIRED: "expired", // entry existed but was past TTL (treated as miss)
});

/**
 * Discovery event types. Future Layer 6 sprints (Presence, Capability Exchange, NAT
 * Traversal) subscribe to these. See {@link module:peer-discovery/events}.
 * @readonly @enum {string}
 */
export const DiscoveryEventType = Object.freeze({
  STARTED: "discovery.started",
  VALIDATED: "discovery.validated",
  SEARCHING: "discovery.searching",
  RESOLVED: "discovery.resolved",
  COMPLETED: "discovery.completed",
  FAILED: "discovery.failed",
  CANCELLED: "discovery.cancelled",
  EXPIRED: "discovery.expired",
  CACHED: "discovery.cached",
  CACHE_INVALIDATED: "discovery.cache_invalidated",
  DEVICE_REGISTERED: "discovery.device_registered",
  DEVICE_DEREGISTERED: "discovery.device_deregistered",
});

/**
 * Machine-readable reasons attached to failure/cancel transitions + validation results.
 * @readonly @enum {string}
 */
export const DiscoveryFailureReason = Object.freeze({
  UNKNOWN_USER: "unknown-user",
  UNKNOWN_DEVICE: "unknown-device",
  NO_DEVICES: "no-devices",
  EXPIRED_SESSION: "expired-session",
  DUPLICATE_REQUEST: "duplicate-request",
  MALFORMED_REQUEST: "malformed-request",
  UNAUTHORIZED_LOOKUP: "unauthorized-lookup",
  CORRUPTED_METADATA: "corrupted-metadata",
  INVALID_STATE: "invalid-state",
  INVALID_TRANSITION: "invalid-transition",
  DIRECTORY_UNAVAILABLE: "directory-unavailable",
  CANCELLED: "cancelled",
  INTERNAL_ERROR: "internal-error",
});

/** Status of a registered discoverable device descriptor in the registry. */
export const RegistryStatus = Object.freeze({
  ACTIVE: "active", // discoverable
  INACTIVE: "inactive", // temporarily not discoverable (e.g. deactivated device)
  REVOKED: "revoked", // permanently not discoverable
});

/** All registry statuses. */
export const ALL_REGISTRY_STATUSES = Object.freeze(Object.values(RegistryStatus));

/** Registry statuses that are discoverable. */
export const DISCOVERABLE_REGISTRY_STATUSES = Object.freeze([RegistryStatus.ACTIVE]);

/** Current discovery-record storage schema version (for future forward-migrations). */
export const DISCOVERY_SCHEMA_VERSION = 1;

/** The framework identifier stamped onto discovery metadata. */
export const DISCOVERY_FRAMEWORK = "peer-discovery";

/** Default discovery-session time-to-live (ms) before it is swept to EXPIRED. */
export const DEFAULT_SESSION_TTL_MS = 30_000;

/** Default positive discovery-cache TTL (ms). */
export const DEFAULT_CACHE_TTL_MS = 60_000;

/** Default negative discovery-cache TTL (ms) — shorter, so "not found" self-heals fast. */
export const DEFAULT_NEGATIVE_CACHE_TTL_MS = 10_000;

/** Default discovery-cache capacity (entries) before LRU eviction. */
export const DEFAULT_CACHE_LIMIT = 5_000;

/** Default window (ms) within which an identical in-flight request is deduplicated. */
export const DEFAULT_DEDUPE_WINDOW_MS = 5_000;

/**
 * @typedef {object} PublicIdentityDescriptor A user's PUBLIC long-term identity. Never a
 *   private key.
 * @property {string} identityId stable identity id
 * @property {string} publicKey base64 raw Ed25519 PUBLIC key
 * @property {string} algorithm key algorithm (e.g. "ed25519")
 * @property {string} fingerprint canonical hex SHA-256 fingerprint of the public key
 * @property {number} [version] identity rotation/version counter
 */

/**
 * @typedef {object} DeviceDescriptor A PUBLIC, discoverable description of one device.
 *   Carries the device's PUBLIC key only. This is the registry's unit of storage and a
 *   line-item of resolved discovery metadata.
 * @property {string} userId owning user id
 * @property {string} [identityId] the identity the device belongs to
 * @property {string} deviceId stable, client-generated device id
 * @property {string} publicKey base64 raw Ed25519 PUBLIC device key
 * @property {string} algorithm device key algorithm
 * @property {string} fingerprint hex SHA-256 fingerprint of the device public key
 * @property {string} [name] human-friendly device name
 * @property {string} [platform] platform descriptor
 * @property {string} status one of {@link RegistryStatus}
 * @property {object} presence FUTURE placeholder — inert presence block
 * @property {object} capabilities FUTURE placeholder — inert capability block
 * @property {object} transport FUTURE placeholder — inert transport block
 * @property {number} version descriptor version counter
 * @property {string} [registeredAt] ISO timestamp
 * @property {string} [updatedAt] ISO timestamp
 * @property {object} [metadata] free-form PUBLIC metadata
 */

/**
 * @typedef {object} DiscoveryMetadata The RESOLVED answer to a lookup — a user's public
 *   discovery record. Metadata ONLY; never key bytes beyond public identity/device keys.
 * @property {string} userId
 * @property {string|null} identityId
 * @property {PublicIdentityDescriptor|null} publicIdentity
 * @property {string[]} deviceIds discoverable device ids
 * @property {DeviceDescriptor[]} devices discoverable device descriptors
 * @property {object} presence FUTURE placeholder — inert
 * @property {object} capabilities FUTURE placeholder — inert
 * @property {object} transport FUTURE placeholder — inert
 * @property {number} version metadata version
 * @property {string} source one of {@link DiscoverySource}
 * @property {string} resolvedAt ISO timestamp
 * @property {number} schemaVersion
 * @property {object} metadata free-form PUBLIC metadata
 */

/**
 * @typedef {object} DiscoverySession A single lookup's record. Binds a requester +
 *   requester device to a target user (+ optional target devices), tracks the lifecycle
 *   state, holds the resolved metadata, and records audit + history.
 * @property {string} discoveryId
 * @property {string} requester requesting user id
 * @property {string} [requesterDevice] requesting device id
 * @property {string} targetUser the user being discovered
 * @property {string[]} targetDevices requested/resolved device ids (empty = all)
 * @property {string} lookupType one of {@link LookupType}
 * @property {string} state one of {@link DiscoveryState}
 * @property {string} requestTime ISO timestamp the lookup was requested
 * @property {string} createdAt @property {string} updatedAt
 * @property {string} expiresAt ISO timestamp the session expires
 * @property {string|null} resolvedAt @property {string|null} completedAt
 * @property {DiscoveryMetadata|null} result the resolved metadata (when RESOLVED)
 * @property {object} capabilitiesSnapshot FUTURE placeholder — inert capability snapshot
 * @property {string|null} failureReason one of {@link DiscoveryFailureReason}
 * @property {object[]} audit append-only audit trail
 * @property {Array<{from:string|null,to:string,at:string,reason?:string}>} history transitions
 * @property {object} metadata free-form
 * @property {number} schemaVersion
 */

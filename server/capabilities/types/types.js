/**
 * @module capabilities/types
 *
 * Enums and type declarations for the **Capability Exchange & Transport Negotiation** subsystem
 * — Layer 6, Sprint 3. It answers a single question:
 *
 * > *"How can these two devices communicate?"*
 *
 * Each device advertises a **capability set** (protocol/crypto versions, supported transports,
 * compression, attachment limits, feature flags, …). Given two capability sets, the
 * {@link module:capabilities/negotiation negotiation engine} deterministically computes what the
 * two devices have in common and which transport they should PREFER.
 *
 * @security This sprint exposes ONLY public capability metadata — versions, transport names,
 * feature flags, limits, platform descriptors. It NEVER exposes private keys, session keys,
 * message keys, chain keys, or shared secrets. See {@link module:capabilities/validators} for the
 * enforced no-secret invariant.
 *
 * @evolution Capability Exchange is transport-INDEPENDENT and **does NOT establish connections**.
 * It determines COMPATIBILITY and a PREFERRED strategy only. Future Layer 6/7 sprints (NAT
 * Traversal, ICE/STUN/TURN, WebRTC, QUIC) consume the negotiation result to actually open a
 * connection. The `p2p` capability + the negotiation result's `transport` block are the extension
 * points those sprints populate.
 */

/** The current protocol version this build speaks. */
export const CURRENT_PROTOCOL_VERSION = "1.0";
/** Protocol versions this build supports (advertised + accepted in negotiation). */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(["1.0"]);

/** The current crypto/transport-security version (aligns with the SHS key-agreement version). */
export const CURRENT_CRYPTO_VERSION = "1.0";
/** Crypto versions this build supports. */
export const SUPPORTED_CRYPTO_VERSIONS = Object.freeze(["1.0"]);

/**
 * Transport types a device can declare SUPPORT for. Declaring support ≠ establishing a
 * connection — this sprint only selects a PREFERENCE among the transports two devices share.
 * @readonly @enum {string}
 */
export const TransportType = Object.freeze({
  WEBSOCKET: "websocket", // available today (relay via the existing socket)
  RELAY: "relay", // server-relayed transport
  WEBRTC: "webrtc", // FUTURE — data channel (Layer 6/7 NAT sprints)
  QUIC: "quic", // FUTURE
  TCP: "tcp", // FUTURE — direct TCP
});

/** All known transport types. */
export const ALL_TRANSPORT_TYPES = Object.freeze(Object.values(TransportType));

/**
 * Transports considered ESTABLISHABLE in the current layer. Others are declarable + negotiable as
 * a preference, but connection establishment is a later layer — negotiating them here only
 * records the preference.
 */
export const ESTABLISHABLE_TRANSPORTS = Object.freeze([TransportType.WEBSOCKET, TransportType.RELAY]);

/** Compression algorithms a device can declare support for. */
export const CompressionType = Object.freeze({
  NONE: "none",
  GZIP: "gzip",
  DEFLATE: "deflate",
  BROTLI: "brotli",
});

/** All known compression types. */
export const ALL_COMPRESSION_TYPES = Object.freeze(Object.values(CompressionType));

/**
 * Capability-set lifecycle states. A capability set is a validated finite state machine over
 * these (see {@link module:capabilities/lifecycle}).
 *
 * - `REGISTERED` — stored, not yet advertised for negotiation.
 * - `ADVERTISED` — published + available for negotiation (the normal live state).
 * - `EXPIRED`    — outlived its TTL without a refresh (resting; a re-register revives it).
 * - `REMOVED`    — deleted.
 * @readonly @enum {string}
 */
export const CapabilityState = Object.freeze({
  REGISTERED: "registered",
  ADVERTISED: "advertised",
  EXPIRED: "expired",
  REMOVED: "removed",
});

/** All capability-set states. */
export const ALL_CAPABILITY_STATES = Object.freeze(Object.values(CapabilityState));

/** States in which a capability set is usable in negotiation. */
export const NEGOTIABLE_CAPABILITY_STATES = Object.freeze([CapabilityState.REGISTERED, CapabilityState.ADVERTISED]);

/** Whether a capability set can participate in negotiation. @param {string} state @returns {boolean} */
export function isNegotiableState(state) {
  return NEGOTIABLE_CAPABILITY_STATES.includes(state);
}

/**
 * The outcome state of a single negotiation.
 * @readonly @enum {string}
 */
export const NegotiationState = Object.freeze({
  PENDING: "pending",
  NEGOTIATING: "negotiating",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
});

/** All negotiation states. */
export const ALL_NEGOTIATION_STATES = Object.freeze(Object.values(NegotiationState));

/**
 * Capability event types. Future Layer 6/7 sprints (NAT Traversal) subscribe to these.
 * @readonly @enum {string}
 */
export const CapabilityEventType = Object.freeze({
  REGISTERED: "capabilities.registered",
  ADVERTISED: "capabilities.advertised",
  UPDATED: "capabilities.updated",
  REFRESHED: "capabilities.refreshed",
  EXPIRED: "capabilities.expired",
  REMOVED: "capabilities.removed",
  NEGOTIATION_STARTED: "capabilities.negotiation_started",
  NEGOTIATION_SUCCEEDED: "capabilities.negotiation_succeeded",
  NEGOTIATION_FAILED: "capabilities.negotiation_failed",
  PREFERRED_TRANSPORT_SELECTED: "capabilities.preferred_transport_selected",
  CACHE_INVALIDATED: "capabilities.cache_invalidated",
});

/**
 * Machine-readable reasons attached to negotiation failures + validation results.
 * @readonly @enum {string}
 */
export const CapabilityFailureReason = Object.freeze({
  UNKNOWN_PROTOCOL_VERSION: "unknown-protocol-version",
  INCOMPATIBLE_PROTOCOL_VERSION: "incompatible-protocol-version",
  UNSUPPORTED_CRYPTO_VERSION: "unsupported-crypto-version",
  INCOMPATIBLE_CRYPTO_VERSION: "incompatible-crypto-version",
  NO_SHARED_TRANSPORT: "no-shared-transport",
  TRANSPORT_CONFLICT: "transport-conflict",
  INVALID_FEATURE_FLAGS: "invalid-feature-flags",
  MALFORMED_METADATA: "malformed-metadata",
  DUPLICATE_REGISTRATION: "duplicate-registration",
  UNKNOWN_CAPABILITY: "unknown-capability",
  EXPIRED_CAPABILITY: "expired-capability",
  UNAUTHORIZED: "unauthorized",
  INTERNAL_ERROR: "internal-error",
});

/** How a negotiation result was sourced (observability). */
export const CapabilitySource = Object.freeze({
  CACHE: "cache",
  COMPUTED: "computed",
  NEGATIVE_CACHE: "negative-cache",
});

/** Current capability-record storage schema version (for future forward-migrations). */
export const CAPABILITY_SCHEMA_VERSION = 1;

/** The framework identifier stamped onto capability records. */
export const CAPABILITY_FRAMEWORK = "capabilities";

/** Default capability-set TTL (ms) — long, since capabilities change rarely (5 min). */
export const DEFAULT_CAPABILITY_TTL_MS = 300_000;

/** Default negotiation-result cache TTL (ms). */
export const DEFAULT_NEGOTIATION_CACHE_TTL_MS = 60_000;

/** Default negative negotiation-cache TTL (ms) — shorter, so "incompatible" self-heals. */
export const DEFAULT_NEGOTIATION_NEGATIVE_CACHE_TTL_MS = 15_000;

/** Default negotiation-cache capacity (entries) before LRU eviction. */
export const DEFAULT_CAPABILITY_CACHE_LIMIT = 5_000;

/** Cap on a capability set's embedded version-history length. */
export const DEFAULT_VERSION_HISTORY_LIMIT = 50;

/** Default maximum payload size (bytes) a device advertises support for (16 MiB). */
export const DEFAULT_MAX_PAYLOAD_SIZE = 16 * 1024 * 1024;

/**
 * @typedef {object} CapabilitySet A device's advertised communication capabilities. Extensible:
 *   unknown feature flags + metadata are carried through negotiation.
 * @property {string} capabilityId stable id
 * @property {string} userId @property {string|null} identityId @property {string} deviceId
 * @property {string[]} protocolVersions supported protocol versions
 * @property {string[]} cryptoVersions supported crypto versions
 * @property {string[]} transports supported transport types (in the device's own preference order)
 * @property {string[]} compression supported compression algorithms (preference order)
 * @property {{ supported: boolean, maxSize: number, mimeTypes?: string[] }} attachments
 * @property {number} maxPayloadSize max payload the device accepts (bytes)
 * @property {boolean} relaySupport whether the device can use a server relay
 * @property {object} p2p FUTURE placeholder — inert P2P support block
 * @property {string[]} connectionPreferences ordered transport preference (policy input)
 * @property {string[]} platformFeatures declared platform feature descriptors
 * @property {string} [softwareVersion]
 * @property {Record<string, boolean>} featureFlags named boolean feature toggles
 * @property {string} state one of {@link CapabilityState}
 * @property {number} version capability version counter (bumped on every update)
 * @property {string} registeredAt @property {string} updatedAt @property {string} expiresAt
 * @property {Array<{version:number,at:string,reason?:string}>} versionHistory
 * @property {object} metadata free-form PUBLIC metadata
 * @property {number} schemaVersion
 */

/**
 * @typedef {object} NegotiationResult The deterministic outcome of negotiating two capability
 *   sets — WHAT the two devices share + which transport they should PREFER. Never a connection.
 * @property {boolean} compatible whether the two devices can communicate at all
 * @property {string|null} protocolVersion highest common protocol version
 * @property {string|null} cryptoVersion highest common crypto version
 * @property {string} compression chosen shared compression (or "none")
 * @property {{ supported: boolean, maxSize: number }} attachments negotiated attachment support
 * @property {number} maxPayloadSize min of the two devices' limits
 * @property {string[]} sharedTransports transports both devices support
 * @property {string|null} preferredTransport the policy-selected transport (null if none shared)
 * @property {string[]} fallbackChain ordered remaining shared transports
 * @property {Record<string, boolean>} featureFlags flags BOTH devices enable
 * @property {boolean} relay whether both devices support a relay
 * @property {string|null} failureReason one of {@link CapabilityFailureReason} when incompatible
 * @property {string} policy the transport-preference policy applied
 * @property {object} transport FUTURE placeholder — inert (candidates/relays filled by NAT sprint)
 * @property {number} schemaVersion
 */

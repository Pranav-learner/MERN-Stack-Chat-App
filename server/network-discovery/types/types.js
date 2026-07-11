/**
 * @module network-discovery/types
 *
 * Enums + constants for the **Network Discovery & Candidate Gathering** subsystem — Layer 7,
 * Sprint 1. This subsystem discovers a device's LOCAL networking environment and produces a
 * reusable {@link NetworkProfile} + ICE-style {@link ConnectionCandidate}s. It is the input a
 * FUTURE ICE/TURN/WebRTC sprint consumes to actually establish connections.
 *
 * ```
 * interfaces (host)  +  STUN (server-reflexive)  →  NAT classification  →  Network Profile + Candidates
 * ```
 *
 * @security A network profile / candidate contains PUBLIC addressing metadata ONLY — IPs, ports,
 * NAT type, interface descriptors. It NEVER contains a private key, session key, message key,
 * chain key, or shared secret. (Addresses are sensitive but not cryptographic secrets; the
 * no-secret invariant is still enforced.)
 *
 * @evolution Transport-INDEPENDENT + injectable: the manager takes an interface provider + a STUN
 * client so it runs in Node (real `os` interfaces + UDP STUN), in the browser (WebRTC-gathered
 * candidates supplied by the app), or under test (mocks). This sprint does NOT perform ICE
 * connectivity checks, candidate-pair selection, TURN relay, or any peer connection — it only
 * discovers + gathers.
 */

/**
 * ICE-style candidate types (RFC 8445). `RELAY` is a PLACEHOLDER here — TURN is a future sprint.
 * @readonly @enum {string}
 */
export const CandidateType = Object.freeze({
  HOST: "host", // a local interface address (private)
  SERVER_REFLEXIVE: "srflx", // the public address a STUN server observed
  PEER_REFLEXIVE: "prflx", // FUTURE — discovered during ICE connectivity checks (Sprint 2)
  RELAY: "relay", // FUTURE — a TURN-allocated relay address (placeholder)
});

/** All candidate types. */
export const ALL_CANDIDATE_TYPES = Object.freeze(Object.values(CandidateType));

/** RFC 8445 type preferences (higher = more preferred). Used in the priority formula. */
export const TYPE_PREFERENCE = Object.freeze({
  [CandidateType.HOST]: 126,
  [CandidateType.PEER_REFLEXIVE]: 110,
  [CandidateType.SERVER_REFLEXIVE]: 100,
  [CandidateType.RELAY]: 0,
});

/** Transport protocols a candidate can use. */
export const TransportProtocol = Object.freeze({ UDP: "udp", TCP: "tcp" });

/** IP address families. */
export const AddressFamily = Object.freeze({ IPV4: "IPv4", IPV6: "IPv6" });

/**
 * Detected NAT type. Full RFC 3489-style classification needs behaviour tests across servers;
 * this sprint distinguishes what mapping behaviour reveals + marks the rest for future diagnostics.
 * @readonly @enum {string}
 */
export const NatType = Object.freeze({
  NO_NAT: "no-nat", // public address == a local host address (open / on the public internet)
  CONE: "cone", // consistent public mapping across STUN servers (full/restricted indistinguishable yet)
  SYMMETRIC: "symmetric", // different public mapping per STUN server (hardest to traverse)
  BLOCKED: "blocked", // no STUN response — UDP likely blocked
  UNKNOWN: "unknown", // insufficient data to classify
});

/** All NAT types. */
export const ALL_NAT_TYPES = Object.freeze(Object.values(NatType));

/** A network profile's lifecycle state. */
export const ProfileState = Object.freeze({
  DISCOVERING: "discovering", // gathering in progress
  READY: "ready", // profile + candidates available
  EXPIRED: "expired", // outlived its TTL (network may have changed)
  STALE: "stale", // superseded by a refresh
  FAILED: "failed", // discovery failed
});

/** All profile states. */
export const ALL_PROFILE_STATES = Object.freeze(Object.values(ProfileState));

/**
 * Network-discovery event types. Future ICE (Sprint 2) subscribes to these.
 * @readonly @enum {string}
 */
export const DiscoveryEventType = Object.freeze({
  DISCOVERY_STARTED: "netdisc.discovery_started",
  PROFILE_CREATED: "netdisc.profile_created",
  PROFILE_REFRESHED: "netdisc.profile_refreshed",
  NAT_DETECTED: "netdisc.nat_detected",
  STUN_RESOLVED: "netdisc.stun_resolved",
  STUN_FAILED: "netdisc.stun_failed",
  CANDIDATE_GATHERED: "netdisc.candidate_gathered",
  CANDIDATE_EXPIRED: "netdisc.candidate_expired",
  NETWORK_CHANGED: "netdisc.network_changed",
  DISCOVERY_FAILED: "netdisc.discovery_failed",
  CACHE_INVALIDATED: "netdisc.cache_invalidated",
});

/** Machine-readable failure/validation reasons. */
export const DiscoveryFailureReason = Object.freeze({
  NO_INTERFACES: "no-interfaces",
  INVALID_INTERFACE: "invalid-interface",
  MISSING_PUBLIC_ADDRESS: "missing-public-address",
  STUN_TIMEOUT: "stun-timeout",
  STUN_UNREACHABLE: "stun-unreachable",
  MALFORMED_CANDIDATE: "malformed-candidate",
  DUPLICATE_CANDIDATE: "duplicate-candidate",
  EXPIRED_PROFILE: "expired-profile",
  INVALID_NAT_METADATA: "invalid-nat-metadata",
  UNAUTHORIZED: "unauthorized",
  INTERNAL_ERROR: "internal-error",
});

/** How a discovery result was sourced (observability). */
export const DiscoverySource = Object.freeze({ CACHE: "cache", COMPUTED: "computed", REPORTED: "reported" });

/** Current network-discovery record storage schema version. */
export const NETDISC_SCHEMA_VERSION = 1;

/** The subsystem identifier stamped onto profiles + candidates. */
export const NETDISC_FRAMEWORK = "network-discovery";

/** ICE component id for a single (RTP) media/data component. */
export const DEFAULT_COMPONENT_ID = 1;

/** Default STUN request timeout (ms) before a retry. */
export const DEFAULT_STUN_TIMEOUT_MS = 500;

/** Default number of STUN retries per server before falling through to the next. */
export const DEFAULT_STUN_RETRIES = 2;

/** Default network-profile TTL (ms) — a profile is a snapshot; the network can change. */
export const DEFAULT_PROFILE_TTL_MS = 300_000;

/** Default candidate TTL (ms) — candidates expire and must be re-gathered. */
export const DEFAULT_CANDIDATE_TTL_MS = 300_000;

/** Default discovery-cache TTL (ms). */
export const DEFAULT_CACHE_TTL_MS = 60_000;

/** Default discovery-cache capacity before LRU eviction. */
export const DEFAULT_CACHE_LIMIT = 5_000;

/** Well-known public STUN servers used as safe defaults (fallback-ordered). */
export const DEFAULT_STUN_SERVERS = Object.freeze([
  { host: "stun.l.google.com", port: 19302 },
  { host: "stun1.l.google.com", port: 19302 },
  { host: "stun.cloudflare.com", port: 3478 },
]);

/**
 * @typedef {object} NetworkInterfaceDescriptor A PUBLIC descriptor of a local interface.
 * @property {string} name @property {string} family one of {@link AddressFamily}
 * @property {string} address the interface IP @property {boolean} internal loopback/internal
 * @property {string} [mac] @property {number} [scopeid] IPv6 scope
 */

/**
 * @typedef {object} ConnectionCandidate An ICE-style candidate (RFC 8445 shape). PUBLIC addressing
 *   metadata only.
 * @property {string} candidateId @property {string} foundation @property {number} component
 * @property {string} transport one of {@link TransportProtocol}
 * @property {number} priority RFC 8445 priority @property {string} type one of {@link CandidateType}
 * @property {string} ip @property {number} port
 * @property {string|null} relatedAddress base/related IP (srflx/relay) @property {number|null} relatedPort
 * @property {string} sdp the `a=candidate:` SDP line @property {object} metadata
 * @property {string} gatheredAt @property {string} expiresAt
 */

/**
 * @typedef {object} NetworkProfile A device's discovered network environment. NO cryptographic
 *   secrets.
 * @property {string} profileId @property {string} deviceId @property {string} userId
 * @property {string} state one of {@link ProfileState}
 * @property {string[]} privateAddresses @property {string|null} publicAddress
 * @property {number[]} privatePorts @property {number[]} publicPorts
 * @property {string} natType one of {@link NatType}
 * @property {NetworkInterfaceDescriptor[]} interfaces
 * @property {ConnectionCandidate[]} candidates
 * @property {object} connectionMetadata @property {object} nat NAT diagnostics block
 * @property {object} diagnostics STUN/latency diagnostics
 * @property {string} discoveredAt @property {string} expiresAt @property {number} version
 * @property {number} schemaVersion
 */

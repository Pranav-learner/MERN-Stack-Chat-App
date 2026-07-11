/**
 * @module network-discovery
 *
 * Public entry point of the **Network Discovery & Candidate Gathering** subsystem — Layer 7,
 * Sprint 1. It discovers a device's LOCAL networking environment (interfaces, public/private
 * addresses, NAT type via STUN) and produces a reusable {@link NetworkProfile} + ICE-style
 * {@link ConnectionCandidate}s.
 *
 * ## Out of scope (Layer 7 · Sprint 2+)
 * NO ICE connectivity checks, NO candidate-pair selection, NO TURN relay, NO WebRTC, NO peer
 * connections, NO socket establishment. This sprint DISCOVERS + GATHERS only; a future ICE sprint
 * consumes the profile + candidates.
 *
 * @security Everything here is PUBLIC network addressing metadata — IPs, ports, NAT type, interface
 * descriptors, candidates. The subsystem NEVER touches a private key, session key, message key,
 * chain key, or shared secret; the {@link module:network-discovery/validators} no-secret invariant is
 * enforced before storage.
 *
 * @example
 * ```js
 * import { NetworkDiscoveryManager, createInMemoryDiscoveryRepository, StunClient, createNodeInterfaceProvider } from "./network-discovery/index.js";
 * const mgr = new NetworkDiscoveryManager({ ...createInMemoryDiscoveryRepository(), interfaceProvider: createNodeInterfaceProvider(), stunClient });
 * const profile = await mgr.generateProfile({ deviceId: "d1", userId: "u1" });
 * ```
 */

// Manager + API facade
export { NetworkDiscoveryManager } from "./manager/networkDiscoveryManager.js";
export { createDiscoveryApi } from "./api/discoveryApi.js";

// Interfaces
export {
  createNodeInterfaceProvider,
  createStaticInterfaceProvider,
  normalizeInterfaces,
  usableInterfaces,
  isInterfaceProvider,
  isPrivateIPv4,
  isLoopback,
  isLinkLocalIPv6,
} from "./interfaces/interfaces.js";

// STUN
export { StunClient } from "./stun/stunClient.js";
export {
  buildBindingRequest,
  parseStunMessage,
  encodeBindingResponse,
  StunMessageType,
  StunAttribute,
  MAGIC_COOKIE,
} from "./stun/stunMessage.js";

// NAT
export { classifyNat } from "./nat/natDetector.js";

// Candidates
export {
  gatherCandidates,
  createHostCandidate,
  createServerReflexiveCandidate,
  createRelayPlaceholder,
  normalizeCandidate,
  computePriority,
  computeFoundation,
  candidateToSdp,
  dedupeCandidates,
  isCandidateExpired,
} from "./candidates/candidate.js";

// Profile
export { createNetworkProfile, isProfileExpired, networkSignature } from "./profile/profile.js";

// Cache
export { NetworkProfileCache, CacheOutcome } from "./cache/cache.js";

// Repositories
export { createInMemoryDiscoveryRepository } from "./repository/inMemoryDiscoveryRepository.js";
export { createMongoDiscoveryRepository } from "./repository/mongoDiscoveryRepository.js";

// Events
export { DiscoveryEventBus } from "./events/events.js";

// Validation
export {
  validateProfileId,
  validateUserRef,
  validateDeviceRef,
  validatePort,
  validateInterfaces,
  validateCandidate,
  validateCandidates,
  validateNatMetadata,
  validateGenerateRequest,
  requireProfile,
  assertProfileNotExpired,
  assertOwner,
  assertNoSecretMaterial,
  validateProfile,
  validateProfileRepository,
  isValidIPv4,
  FORBIDDEN_SECRET_KEYS,
} from "./validators/validators.js";

// Serialization
export {
  toPublicProfile,
  toPublicCandidate,
  toProfileSummary,
  toNatInfo,
  toPublicAddress,
  toDiagnostics,
} from "./serializers/serializer.js";

// Errors + types
export * from "./errors.js";
export {
  CandidateType,
  ALL_CANDIDATE_TYPES,
  TYPE_PREFERENCE,
  TransportProtocol,
  AddressFamily,
  NatType,
  ALL_NAT_TYPES,
  ProfileState,
  ALL_PROFILE_STATES,
  DiscoveryEventType,
  DiscoveryFailureReason,
  DiscoverySource,
  NETDISC_SCHEMA_VERSION,
  NETDISC_FRAMEWORK,
  DEFAULT_STUN_TIMEOUT_MS,
  DEFAULT_STUN_RETRIES,
  DEFAULT_PROFILE_TTL_MS,
  DEFAULT_CANDIDATE_TTL_MS,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CACHE_LIMIT,
  DEFAULT_STUN_SERVERS,
} from "./types/types.js";

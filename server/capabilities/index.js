/**
 * @module capabilities
 *
 * Public entry point of the **Capability Exchange & Transport Negotiation** subsystem — Layer 6,
 * Sprint 3. Builds the negotiation control plane that answers *"how can these two devices
 * communicate?"*: a Capability Manager, per-device capability sets with a validated lifecycle, a
 * deterministic negotiation engine, transport-preference policies, version-aware caching,
 * validation, repositories, events, and a transport-independent API facade.
 *
 * ## Out of scope for Sprint 3 (future Layer 6/7 sprints)
 * NO NAT Traversal, NO ICE/STUN/TURN, NO WebRTC, NO direct P2P, NO connection establishment. This
 * subsystem determines COMPATIBILITY + a PREFERRED communication strategy only. Future sprints
 * consume the {@link module:capabilities/negotiation negotiation result} + these events to actually
 * open a connection. The `p2p` capability block + the result's `transport` block are the extension
 * points those sprints populate.
 *
 * @security Everything here is PUBLIC control-plane metadata — versions, transport names, feature
 * flags, limits. The subsystem NEVER touches a private key, session key, message key, chain key, or
 * shared secret; the {@link module:capabilities/validators} no-secret invariant is enforced before
 * anything is stored or returned.
 *
 * @example Device / test wiring (zero deps)
 * ```js
 * import { CapabilityManager, createInMemoryCapabilityRepository } from "./capabilities/index.js";
 * const caps = new CapabilityManager({ ...createInMemoryCapabilityRepository() });
 * await caps.registerCapabilities({ userId: "u1", deviceId: "d1", transports: ["websocket","relay"] });
 * ```
 *
 * @example Server wiring (Mongo)
 * ```js
 * import { CapabilityManager, createMongoCapabilityRepository, createCapabilityApi } from "./capabilities/index.js";
 * const manager = new CapabilityManager({ ...createMongoCapabilityRepository() });
 * const api = createCapabilityApi(manager);
 * ```
 */

// Manager + API facade
export { CapabilityManager } from "./manager/capabilityManager.js";
export { createCapabilityApi } from "./api/capabilityApi.js";

// Negotiation engine
export { negotiateCapabilities, negotiationKey } from "./negotiation/negotiation.js";

// Transport policies
export {
  TransportPolicy,
  DEFAULT_TRANSPORT_POLICY,
  resolvePolicy,
  orderByPolicy,
  selectPreferredTransport,
} from "./policies/transportPolicy.js";

// Version utility
export {
  parseVersion,
  isValidVersion,
  compareVersions,
  versionsEqual,
  highestCommonVersion,
  maxVersion,
  normalizeVersions,
} from "./version/version.js";

// Cache
export { CapabilityCache, CapabilityCacheOutcome } from "./cache/cache.js";

// Repositories
export { createInMemoryCapabilityRepository } from "./repository/inMemoryCapabilityRepository.js";
export { createMongoCapabilityRepository } from "./repository/mongoCapabilityRepository.js";

// Events
export { CapabilityEventBus } from "./events/events.js";

// Record model + advertisement
export {
  createCapabilityRecord,
  appendVersionHistory,
  isCapabilityExpired,
  capabilityKey,
  toNegotiable,
} from "./record/capabilityRecord.js";
export {
  createCapabilityAdvertisement,
  createP2PPlaceholder,
} from "./advertisement/advertisement.js";

// Lifecycle
export {
  CapabilityLifecycle,
  ALLOWED_CAPABILITY_TRANSITIONS,
  canCapabilityTransition,
  assertCapabilityTransition,
  nextCapabilityStates,
  isTerminalCapabilityState,
} from "./lifecycle/lifecycle.js";

// Validation
export {
  validateCapabilityId,
  validateUserRef,
  validateDeviceRef,
  validateVersionList,
  validateTransports,
  validateCompression,
  validateFeatureFlags,
  validateCapabilityRequest,
  requireCapability,
  assertNotExpired,
  assertOwner,
  assertNoDuplicateRegistration,
  assertNoSecretMaterial,
  validateCapabilityRecord,
  validateCapabilityRepository,
  validateNegotiationRepository,
  FORBIDDEN_SECRET_KEYS,
} from "./validators/validators.js";

// Serialization
export {
  toPublicCapabilities,
  toPublicNegotiation,
  toCapabilityStatus,
  toPublicNegotiationRecord,
} from "./serializers/serializer.js";

// Errors + types
export * from "./errors.js";
export {
  TransportType,
  ALL_TRANSPORT_TYPES,
  ESTABLISHABLE_TRANSPORTS,
  CompressionType,
  ALL_COMPRESSION_TYPES,
  CapabilityState,
  ALL_CAPABILITY_STATES,
  NEGOTIABLE_CAPABILITY_STATES,
  isNegotiableState,
  NegotiationState,
  ALL_NEGOTIATION_STATES,
  CapabilityEventType,
  CapabilityFailureReason,
  CapabilitySource,
  CURRENT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  CURRENT_CRYPTO_VERSION,
  SUPPORTED_CRYPTO_VERSIONS,
  CAPABILITY_SCHEMA_VERSION,
  CAPABILITY_FRAMEWORK,
  DEFAULT_CAPABILITY_TTL_MS,
  DEFAULT_NEGOTIATION_CACHE_TTL_MS,
  DEFAULT_NEGOTIATION_NEGATIVE_CACHE_TTL_MS,
  DEFAULT_CAPABILITY_CACHE_LIMIT,
  DEFAULT_MAX_PAYLOAD_SIZE,
} from "./types/types.js";

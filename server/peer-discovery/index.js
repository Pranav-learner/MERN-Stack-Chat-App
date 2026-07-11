/**
 * @module peer-discovery
 *
 * Public entry point of the **Peer Discovery Framework** — Layer 6, Sprint 1. Builds the
 * reusable networking CONTROL PLANE that answers *"How do devices discover each other?"*:
 * a Discovery Manager, discovery sessions with a deterministic state machine, a device/user
 * registry backed by an authoritative directory, resolved discovery metadata, TTL/negative
 * caching, validation, repositories, events, and a transport-independent API facade.
 *
 * ## Out of scope for Sprint 1 (future Layer 6 sprints)
 * NO Presence, NO Capability Exchange, NO NAT Traversal, NO ICE/STUN/TURN, NO WebRTC, NO
 * QUIC/TCP, NO P2P, NO direct sockets, NO transport negotiation. Discovery answers WHO a
 * peer is + WHICH devices they have — never HOW to reach them. The presence, capability,
 * and transport placeholders on every descriptor are the extension points future sprints
 * populate.
 *
 * @security Everything here is PUBLIC control-plane metadata — public identity/device keys
 * + fingerprints, ids, states, counts. The framework NEVER touches a private key, session
 * key, message key, chain key, or shared secret; the {@link module:peer-discovery/validators}
 * no-secret invariant is enforced before anything is stored or returned.
 *
 * @example Device / test wiring (zero deps)
 * ```js
 * import { DiscoveryManager, createInMemoryDiscoveryRepository, createInMemoryDirectory } from "./peer-discovery/index.js";
 * const repo = createInMemoryDiscoveryRepository();
 * const directory = createInMemoryDirectory({ u2: { identity, devices } });
 * const discovery = new DiscoveryManager({ ...repo, directory });
 * const { session } = await discovery.lookupUser({ requester: "u1", targetUser: "u2" });
 * ```
 *
 * @example Server wiring (Mongo, identity/device directory)
 * ```js
 * import { DiscoveryManager, createMongoDiscoveryRepository, createDiscoveryApi } from "./peer-discovery/index.js";
 * const discovery = new DiscoveryManager({ ...createMongoDiscoveryRepository(), directory: mongoDirectory });
 * const api = createDiscoveryApi(discovery);
 * ```
 */

// Manager + API facade
export { DiscoveryManager } from "./manager/discoveryManager.js";
export { createDiscoveryApi } from "./api/discoveryApi.js";

// Registry + directory
export { DiscoveryRegistry } from "./registry/registry.js";
export { createInMemoryDirectory, isDirectoryProvider } from "./registry/directory.js";
export { createMongoIdentityDirectory } from "./registry/mongoIdentityDirectory.js";

// Cache
export { DiscoveryCache, cacheKey } from "./cache/cache.js";

// Repositories
export { createInMemoryDiscoveryRepository } from "./repository/inMemoryDiscoveryRepository.js";
export { createMongoDiscoveryRepository } from "./repository/mongoDiscoveryRepository.js";

// Events
export { DiscoveryEventBus } from "./events/events.js";

// Session model + helpers
export {
  createDiscoverySession,
  inferLookupType,
  isDiscoverySessionExpired,
  isDiscoverySessionTerminal,
  discoveryDedupeKey,
} from "./session/discoverySession.js";

// Lifecycle
export {
  DiscoveryLifecycle,
  ALLOWED_DISCOVERY_TRANSITIONS,
  canDiscoveryTransition,
  assertDiscoveryTransition,
  nextDiscoveryStates,
} from "./lifecycle/lifecycle.js";

// Metadata framework
export {
  createDiscoveryMetadata,
  createDeviceDescriptor,
  createIdentityDescriptor,
  createPresencePlaceholder,
  createCapabilityPlaceholder,
  createTransportPlaceholder,
  createCapabilitiesSnapshot,
  createAuditEntry,
  appendAudit,
} from "./metadata/metadata.js";

// Validation
export {
  validateDiscoveryId,
  validateUserRef,
  validateDeviceRef,
  validateLookupType,
  validateLookupRequest,
  requireDiscoverySession,
  assertNotExpired,
  assertRequester,
  assertNoDuplicateDiscovery,
  assertNoSecretMaterial,
  validateDiscoveryMetadata,
  validateDiscoverySession,
  validateSessionRepository,
  validateRegistryRepository,
  FORBIDDEN_SECRET_KEYS,
} from "./validators/validators.js";

// Serialization
export {
  toPublicDiscoverySession,
  toPublicDiscoveryMetadata,
  toPublicDeviceDescriptor,
  toDiscoveryStatus,
  toDiscoveryListItem,
} from "./serializers/serializer.js";

// Errors + types
export * from "./errors.js";
export {
  DiscoveryState,
  ALL_DISCOVERY_STATES,
  ACTIVE_DISCOVERY_STATES,
  TERMINAL_DISCOVERY_STATES,
  RESOLVED_DISCOVERY_STATES,
  isTerminalDiscoveryState,
  isActiveDiscoveryState,
  isResolvedDiscoveryState,
  LookupType,
  ALL_LOOKUP_TYPES,
  DiscoverySource,
  CacheOutcome,
  DiscoveryEventType,
  DiscoveryFailureReason,
  RegistryStatus,
  ALL_REGISTRY_STATUSES,
  DISCOVERABLE_REGISTRY_STATUSES,
  DISCOVERY_SCHEMA_VERSION,
  DISCOVERY_FRAMEWORK,
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_NEGATIVE_CACHE_TTL_MS,
  DEFAULT_CACHE_LIMIT,
  DEFAULT_DEDUPE_WINDOW_MS,
} from "./types/types.js";

/**
 * @module presence
 *
 * Public entry point of the **Presence & Device Advertisement Service** — Layer 6, Sprint 2.
 * Builds the real-time availability CONTROL PLANE that answers *"which authenticated devices
 * are currently reachable?"*: a Presence Manager, per-device presence records with a validated
 * status state machine, a heartbeat/failure-detection system, PUBLIC device advertisements,
 * short-TTL caching, validation, repositories, events, a transport-independent API facade, and
 * a socket-oriented service layer.
 *
 * ## Out of scope for Sprint 2 (future Layer 6 sprints)
 * NO Capability Exchange, NO NAT Traversal, NO ICE/STUN/TURN, NO WebRTC, NO QUIC/TCP, NO P2P,
 * NO direct sockets, NO transport negotiation. Presence reports *whether* a device is reachable,
 * never *how* to reach it. The connection/transport placeholders on every advertisement are the
 * extension points future sprints populate.
 *
 * @security Everything here is PUBLIC control-plane metadata — public identity keys +
 * fingerprints, ids, statuses, timestamps, counts. The framework NEVER touches a private key,
 * session key, message key, chain key, or shared secret; the {@link module:presence/validators}
 * no-secret invariant is enforced before anything is stored or returned.
 *
 * @example Device / test wiring (zero deps)
 * ```js
 * import { PresenceManager, createInMemoryPresenceRepository } from "./presence/index.js";
 * const presence = new PresenceManager({ ...createInMemoryPresenceRepository() });
 * const rec = await presence.registerPresence({ userId: "u1", deviceId: "d1" });
 * const { devices } = await presence.resolveActiveDevices("u1");
 * ```
 *
 * @example Server wiring (Mongo)
 * ```js
 * import { PresenceManager, createMongoPresenceRepository, createPresenceApi, HeartbeatMonitor } from "./presence/index.js";
 * const manager = new PresenceManager({ ...createMongoPresenceRepository() });
 * const api = createPresenceApi(manager);
 * new HeartbeatMonitor({ manager }).start();
 * ```
 */

// Manager + API facade + service
export { PresenceManager, presenceFailureReasonFor } from "./manager/presenceManager.js";
export { createPresenceApi } from "./api/presenceApi.js";
export { createPresenceService } from "./services/presenceService.js";

// Heartbeat
export { HeartbeatMonitor } from "./heartbeat/heartbeat.js";

// Cache
export { PresenceCache, PresenceCacheOutcome } from "./cache/cache.js";

// Repositories
export { createInMemoryPresenceRepository } from "./repository/inMemoryPresenceRepository.js";
export { createMongoPresenceRepository } from "./repository/mongoPresenceRepository.js";

// Events
export { PresenceEventBus } from "./events/events.js";

// Record model + helpers
export {
  createPresenceRecord,
  appendStatusHistory,
  isPresenceExpired,
  msUntilExpiry,
  presenceKey,
} from "./record/presenceRecord.js";

// Advertisement
export {
  createDeviceAdvertisement,
  createPublicIdentity,
  restampAdvertisement,
  createConnectionPlaceholder,
  createTransportPlaceholder,
} from "./advertisement/advertisement.js";

// Lifecycle
export {
  PresenceLifecycle,
  ALLOWED_PRESENCE_TRANSITIONS,
  canPresenceTransition,
  assertPresenceTransition,
  nextPresenceStatuses,
} from "./lifecycle/lifecycle.js";

// Validation
export {
  validatePresenceId,
  validateUserRef,
  validateDeviceRef,
  validateStatus,
  validateUserSettableStatus,
  validateRegistrationRequest,
  requirePresence,
  assertNotExpired,
  assertOwner,
  assertNoDuplicateRegistration,
  assertNoSecretMaterial,
  validateAdvertisement,
  validatePresenceRecord,
  validatePresenceRepository,
  FORBIDDEN_SECRET_KEYS,
} from "./validators/validators.js";

// Serialization
export {
  toPublicPresence,
  toPublicAdvertisement,
  toPresenceStatus,
  toLastSeen,
} from "./serializers/serializer.js";

// Errors + types
export * from "./errors.js";
export {
  PresenceStatus,
  ALL_PRESENCE_STATUSES,
  REACHABLE_PRESENCE_STATUSES,
  VISIBLE_ONLINE_STATUSES,
  UNREACHABLE_PRESENCE_STATUSES,
  USER_SETTABLE_STATUSES,
  isReachableStatus,
  isVisibleOnlineStatus,
  isUserSettableStatus,
  PresenceEventType,
  PresenceFailureReason,
  PresenceSource,
  PRESENCE_SCHEMA_VERSION,
  PRESENCE_FRAMEWORK,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_PRESENCE_CACHE_TTL_MS,
  DEFAULT_PRESENCE_NEGATIVE_CACHE_TTL_MS,
  DEFAULT_PRESENCE_CACHE_LIMIT,
  DEFAULT_STATUS_HISTORY_LIMIT,
} from "./types/types.js";

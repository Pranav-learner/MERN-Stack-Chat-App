/**
 * @module device-trust
 *
 * Public entry point of the Device Trust subsystem (Layer 3, Sprint 2). Builds on
 * the Sprint 1 identity subsystem; treats devices as first-class cryptographic
 * entities with a full trust lifecycle, policies, and events.
 *
 * It stores ONLY public keys, contains NO encryption/handshake/session/P2P logic,
 * and does not modify existing chat/auth behaviour.
 *
 * @example Production wiring (Mongo-backed)
 * ```js
 * import { DeviceManager, createMongoDeviceRepository } from "./device-trust/index.js";
 * const manager = new DeviceManager({ devices: createMongoDeviceRepository().devices });
 * ```
 *
 * @example Tests (in-memory, no DB)
 * ```js
 * import { DeviceManager, createInMemoryDeviceRepository } from "./device-trust/index.js";
 * const manager = new DeviceManager({ devices: createInMemoryDeviceRepository().devices });
 * ```
 */

export { DeviceManager } from "./manager/deviceManager.js";
export { createMongoDeviceRepository } from "./repository/mongoRepository.js";
export { createInMemoryDeviceRepository } from "./repository/inMemoryRepository.js";

export * from "./errors.js";
export {
  TrustStatus,
  DeviceEventType,
  DeviceCapability,
  DeviceAction,
  STORED_TRUST_STATUSES,
} from "./types.js";

export { DeviceEventBus } from "./events/deviceEvents.js";
export { RegistrationPolicy } from "./policies/registrationPolicy.js";
export {
  ALLOWED_TRANSITIONS,
  DEFAULT_INACTIVITY_MS,
  canTransition,
  assertTransition,
  isTrusted,
  effectiveStatus,
  canEstablishSession,
} from "./policies/trustPolicy.js";
export { planTransition } from "./lifecycle/deviceLifecycle.js";
export {
  validateDeviceSubmission,
  validateMetadata,
  validateCapabilities,
} from "./validators/deviceValidators.js";
export { toPublicDevice, toPublicDeviceList } from "./serialization/deviceSerializer.js";
export { NoopDeviceSync } from "./sync/deviceSync.js";
export {
  backfillTrustStatus,
  trustStatusBreakdown,
  DEVICE_TRUST_SCHEMA_VERSION,
} from "./migration/migration.js";

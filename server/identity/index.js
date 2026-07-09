/**
 * @module identity
 *
 * Public entry point of the server-side Identity subsystem (Layer 3, Sprint 1).
 *
 * This subsystem establishes permanent cryptographic identities for users and
 * devices. It stores ONLY public keys — private keys never reach the server. It
 * contains NO end-to-end encryption, handshake, session, or P2P logic (future
 * layers), and it does not modify existing chat/auth functionality.
 *
 * @example Production wiring (Mongo-backed)
 * ```js
 * import { IdentityManager, createMongoRepositories } from "./identity/index.js";
 * const manager = new IdentityManager(createMongoRepositories());
 * ```
 *
 * @example Tests (in-memory, no DB)
 * ```js
 * import { IdentityManager, createInMemoryRepositories } from "./identity/index.js";
 * const manager = new IdentityManager(createInMemoryRepositories());
 * ```
 */

export { IdentityManager } from "./manager/identityManager.js";
export { createMongoRepositories } from "./repository/mongoRepository.js";
export { createInMemoryRepositories } from "./repository/inMemoryRepository.js";

export * from "./errors.js";

export {
  computeFingerprint,
  fingerprintBinary,
  toHumanReadable,
  toNumericCode,
  fingerprintFormats,
  verifyFingerprint,
  FINGERPRINT_ALGORITHM,
} from "./fingerprints/fingerprint.js";

export {
  validatePublicKeySubmission,
  validateDeviceDescriptor,
  decodePublicKey,
  assertValidEd25519PublicKey,
  SUPPORTED_ALGORITHMS,
  ED25519_PUBLIC_KEY_BYTES,
} from "./validators/identityValidators.js";

export {
  toPublicIdentity,
  toPublicDevice,
  toPublicKeyBundle,
} from "./serialization/identitySerializer.js";

export { reportIdentityAdoption, IDENTITY_SCHEMA_VERSION } from "./migration/migration.js";

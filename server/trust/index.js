/**
 * @module trust
 *
 * Public entry point of the Trust subsystem (Layer 3, Sprint 3 — identity
 * verification & trust establishment). Builds on the Sprint 1 identity and
 * Sprint 2 device-trust layers.
 *
 * Establishes user-to-user cryptographic trust via fingerprints, safety numbers,
 * and QR verification. Stores ONLY public material; contains NO handshake,
 * encryption, session, or P2P logic (future layers).
 *
 * @example Production wiring
 * ```js
 * import { TrustManager, createMongoTrustRepositories } from "./trust/index.js";
 * const trust = new TrustManager({
 *   ...createMongoTrustRepositories(),
 *   identityLookup: (userId) => identityManager.getIdentityByUser(userId),
 * });
 * ```
 *
 * @example Tests (in-memory)
 * ```js
 * import { TrustManager, createInMemoryTrustRepositories } from "./trust/index.js";
 * const trust = new TrustManager({ ...createInMemoryTrustRepositories(), identityLookup });
 * ```
 */

export { TrustManager } from "./manager/trustManager.js";
export { createMongoTrustRepositories } from "./repository/mongoRepository.js";
export { createInMemoryTrustRepositories } from "./repository/inMemoryRepository.js";

export * from "./errors.js";
export {
  TrustState,
  STORED_TRUST_STATES,
  VerificationMethod,
  TrustEventType,
  TrustWarningType,
} from "./types.js";

export { TrustEventBus } from "./events/trustEvents.js";
export { buildFingerprint, verifyFingerprint, fingerprintsEqual, FINGERPRINT_VERSION } from "./fingerprints/fingerprint.js";
export {
  computeSafetyNumber,
  formatSafetyNumber,
  normalizeSafetyNumber,
  isValidSafetyNumber,
  SAFETY_NUMBER_VERSION,
} from "./safety-number/safetyNumber.js";
export {
  buildQrPayload,
  serializeQrPayload,
  deserializeQrPayload,
  validateQrPayload,
  QR_PAYLOAD_VERSION,
  QR_PAYLOAD_TYPE,
} from "./qr/qrPayload.js";
export { canTransition, assertTransition, ALLOWED_TRANSITIONS } from "./validators/trustValidators.js";
export { toPublicVerification, toPublicChange } from "./serialization/trustSerializer.js";
export { verificationReport, TRUST_SCHEMA_VERSION } from "./migration/migration.js";

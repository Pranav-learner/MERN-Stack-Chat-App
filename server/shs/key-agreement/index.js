/**
 * @module shs/key-agreement
 *
 * Public entry point of the **Secure Key Agreement** subsystem — Layer 4, Sprint 2.
 * Extends the Sprint 1 Secure Handshake System with cryptographic key agreement:
 * two verified devices each mint a fresh ephemeral X25519 key pair, exchange only
 * their PUBLIC ephemeral keys, and INDEPENDENTLY derive an identical shared secret
 * that is never transmitted.
 *
 * ## Out of scope for Sprint 2
 * NO message encryption, NO session encryption keys, NO forward secrecy, NO double
 * ratchet, NO encrypted attachments, NO P2P/WebRTC, NO transport encryption. Those
 * consume this shared secret in later sprints.
 *
 * @example Relay wiring (server)
 * ```js
 * import { KeyAgreementManager, createMongoKeyAgreementRepositories } from "./shs/key-agreement/index.js";
 * const ka = new KeyAgreementManager({ ...createMongoKeyAgreementRepositories(), sessions });
 * ```
 *
 * @example Device wiring (tests / client-equivalent, zero deps)
 * ```js
 * import { KeyAgreementManager, createInMemoryKeyAgreementRepositories } from "./shs/key-agreement/index.js";
 * const ka = new KeyAgreementManager({ ...createInMemoryKeyAgreementRepositories() });
 * ```
 */

// Manager + repositories
export { KeyAgreementManager } from "./manager/keyAgreementManager.js";
export { createInMemoryKeyAgreementRepositories } from "./repository/inMemoryRepository.js";
export { createMongoKeyAgreementRepositories } from "./repository/mongoRepository.js";

// Errors + types
export * from "./errors.js";
export {
  KeyAgreementAlgorithm,
  SUPPORTED_ALGORITHMS,
  X25519_PUBLIC_KEY_BYTES,
  X25519_SHARED_SECRET_BYTES,
  CRYPTO_PROTOCOL_VERSION,
  MIN_CRYPTO_PROTOCOL_VERSION,
  SUPPORTED_CRYPTO_VERSIONS,
  KeyAgreementRole,
  peerRole,
  ExchangeState,
  KeyAgreementEventType,
  KeyAgreementFailureReason,
} from "./types.js";

// Crypto primitives
export {
  generateKeyPair,
  exportRawPublicKey,
  decodeRawPublicKey,
  validateRawPublicKey,
  importPublicKey,
  deriveSharedSecret,
  isSmallOrderPoint,
  isAllZero,
  constantTimeEqual,
  secretCommitment,
  publicKeyFingerprint,
  signEphemeralKey,
  verifyEphemeralKey,
} from "./crypto/x25519.js";

// Ephemeral keys
export {
  EphemeralKeyStore,
  EPHEMERAL_KEY_VERSION,
  buildBundle,
  serializeBundle,
  deserializeBundle,
} from "./exchange/ephemeralKeys.js";

// Derivation
export {
  deriveSecret,
  validateSecret,
  secretsEqual,
  assertCommitmentsMatch,
  commitmentsMatch,
  disposeSecret,
} from "./derivation/sharedSecret.js";

// Negotiation
export {
  negotiateCrypto,
  canNegotiateCrypto,
  negotiateCryptoVersion,
  isAlgorithmSupported,
  cryptoCapabilities,
} from "./negotiation/cryptoNegotiation.js";

// Validation
export {
  validateBundle,
  verifyBundleSignature,
  validatePeers,
  validateHandshakeRef,
  validateAgainstExchange,
  assertNotDuplicateKey,
  assertNotReplayedKey,
  assertExchangeFresh,
  validateNegotiationPayload,
} from "./validation/keyAgreementValidators.js";

// Session material
export {
  createSessionMaterial,
  isMaterialExpired,
  materialSecretBytes,
  DEFAULT_MATERIAL_TTL_MS,
} from "./session/sessionMaterial.js";

// Serialization (public DTOs — the secret-stripping guardrail)
export { toPublicExchange, toPublicSessionMaterial } from "./serialization/keyAgreementSerializer.js";

// Events
export { KeyAgreementEventBus } from "./events/keyAgreementEvents.js";

// Migration
export {
  KEY_AGREEMENT_SCHEMA_VERSION,
  keyAgreementReport,
  sweepExpiredExchanges,
} from "./migration/migration.js";

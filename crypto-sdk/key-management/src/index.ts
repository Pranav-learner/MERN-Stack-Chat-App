/**
 * @packageDocumentation
 *
 * # @securechat/key-management — Key Management System (Layer 2, Sprint 2)
 *
 * A reusable key-management layer built on top of `@securechat/crypto-sdk`. It
 * owns the full key lifecycle (generate, store, retrieve, import, export,
 * replace, rotate, delete, validate, expire, recover) behind clean abstractions
 * for storage, caching, repositories, serialization, validation, and rotation.
 *
 * It manages keys ONLY. It does not encrypt chat messages, implement a handshake
 * or the Signal protocol, or touch auth / sockets / the database.
 *
 * @example Quick start
 * ```ts
 * import { KeyManager, KeyType } from "@securechat/key-management";
 *
 * const km = new KeyManager();
 * const identity = await km.generateIdentityKey({ owner: "user-1" });
 * const pub = await km.exportKey(identity.keyId);          // public-only JSON
 * const { current } = await km.rotateKey(identity.keyId);  // new Ed25519 version
 * const history = await km.getHistory(current.keyId);      // lineage, oldest-first
 * ```
 *
 * @example Encrypted-at-rest storage
 * ```ts
 * import { KeyManager, SecureStorage, MemoryStorage } from "@securechat/key-management";
 * import { deriveKeyFromPassword, SymmetricKey, randomBytes } from "@securechat/crypto-sdk";
 *
 * const master = SymmetricKey.fromBytes(deriveKeyFromPassword("pass", randomBytes(16)));
 * const km = new KeyManager({ storage: new SecureStorage(new MemoryStorage(), master) });
 * ```
 */

// Core model
export { ManagedKey, type ManagedKeyInit } from "./managed-key.js";
export * from "./types/index.js";
export * from "./errors/index.js";

// Metadata framework
export {
  createKeyMetadata,
  computeFingerprint,
  createIdGenerator,
  systemClock,
  toIso,
  touchMetadata,
  isExpired,
  timeToExpiry,
  type CreateMetadataOptions,
  type MetadataContext,
} from "./metadata/index.js";

// Serialization
export { KeySerializer, CURRENT_FORMAT_VERSION } from "./serializers/index.js";

// Validation
export { KeyValidator, type ValidateOptions } from "./validators/index.js";

// Storage
export {
  KeyStorage,
  matchesFilter,
  MemoryStorage,
  SecureStorage,
  DatabaseStorage,
  HardwareStorage,
  CloudKmsStorage,
} from "./storage/index.js";

// Cache
export {
  InMemoryKeyCache,
  NoopKeyCache,
  type KeyCache,
  type CacheStats,
  type InMemoryKeyCacheOptions,
} from "./cache/index.js";

// Repositories
export {
  BaseKeyRepository,
  IdentityKeyRepository,
  SessionKeyRepository,
  SharedSecretRepository,
  PreKeyRepository,
  SignedPreKeyRepository,
  OneTimeKeyRepository,
  GroupKeyRepository,
  type RepositoryContext,
} from "./repository/index.js";

// Rotation framework
export {
  NeverRotatePolicy,
  ManualRotationPolicy,
  AgeBasedRotationPolicy,
  UsageBasedRotationPolicy,
  ExpiryRotationPolicy,
  CompositeRotationPolicy,
  RotationScheduler,
  NoopSchedulerDriver,
  buildHistoryChain,
  type RotationPolicy,
  type RotationContext,
  type RotationDecision,
  type RotationSchedulerDriver,
  type KeyHistoryEntry,
} from "./rotation/index.js";

// Recovery (future hook)
export { NoopRecoveryProvider, type RecoveryProvider } from "./recovery/index.js";

// Migration (future support)
export { MigrationRegistry, type Migration } from "./migration/index.js";

// Manager (primary entry point)
export {
  KeyManager,
  type KeyManagerOptions,
  type GenerateKeyOptions,
  type ExportKeyOptions,
  type ImportKeyOptions,
  type MaterialGenerator,
  type RotationResult,
} from "./manager/index.js";

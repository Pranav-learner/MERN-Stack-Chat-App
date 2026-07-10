/**
 * @module key-hierarchy
 *
 * Public entry point of the **Key Hierarchy & Chain Management** subsystem — Layer 5,
 * Sprint 4. Replaces the flat session-key model with a structured hierarchy:
 *
 * ```
 * Session Root Key
 *   ├── Sending Chain   (one-way chain-key ratchet)
 *   └── Receiving Chain (one-way chain-key ratchet)
 * ```
 *
 * ## What this sprint adds
 * - a **Session Root Key** derived from the Sprint 2 generation's reserved `ratchetMaterial`;
 * - independent **sending / receiving chains** with a one-way chain-key ratchet;
 * - a **Chain Manager** (establish · advance · re-root · validate · resolve);
 * - repositories, an audit trail, events, and a Secure Transport resolution path with a
 *   **message-key extension point**.
 *
 * ## Out of scope (Sprint 5+)
 * NO per-message keys, NO Double Ratchet, NO Post-Compromise Security. Sprint 5 derives
 * unique per-message keys from the active chains via the extension point.
 *
 * @example Device
 * ```js
 * import { ChainManager, KeyHierarchyKeyStore, createInMemoryKeyHierarchyRepository } from "./key-hierarchy/index.js";
 * const chains = new ChainManager({ ...createInMemoryKeyHierarchyRepository(), keyStore: new KeyHierarchyKeyStore() });
 * await chains.establish({ sessionId, handshakeId, role: "initiator", rootSecret }); // ratchetMaterial from FS
 * await chains.advanceSendingChain(sessionId);
 * ```
 */

// Manager + key store + repositories
export { ChainManager } from "./manager/chainManager.js";
export { KeyHierarchyKeyStore } from "./keystore/keyHierarchyKeyStore.js";
export { createInMemoryKeyHierarchyRepository } from "./repository/inMemoryKeyHierarchyRepository.js";
export { createMongoKeyHierarchyRepository } from "./repository/mongoKeyHierarchyRepository.js";

// Transport integration (+ message-key extension point)
export {
  encryptWithHierarchy,
  decryptWithHierarchy,
  resolveActiveSendingChain,
  createHierarchyTransport,
} from "./transport/transportIntegration.js";

// Derivation + root + chains
export {
  deriveRootKey,
  deriveChainKey,
  advanceChainKey,
  keyFingerprint,
  keyId,
  directionsForRole,
  messageKeyLabel,
  disposeKey,
  hierarchySalt,
} from "./derivation/derivation.js";
export { createRootKeyMeta, isRootKeyLive, supersedeRootKey } from "./root/rootKey.js";
export { createChainMeta, advanceChainMeta, archiveChainMeta, isChainLive } from "./chains/chain.js";

// Metadata + audit + events + serialization + validators
export { createHierarchyMetadata, createSecurityMetadata, recomputeMetadata } from "./metadata/metadata.js";
export { auditEntry, appendAudit, assertNoSecretMaterial, AuditAction } from "./audit/audit.js";
export { KeyHierarchyEventBus, KeyHierarchyEventType } from "./events/events.js";
export { toPublicHierarchy, toHierarchyStatus, toPublicChain, toPublicRootKey } from "./serialization/serializer.js";
export {
  validateSessionRef,
  requireHierarchy,
  assertValidRootKey,
  requireChain,
  assertChainMatch,
  assertChainForward,
  assertNoDuplicateChain,
  validateHierarchyMetadata,
  validateRepository,
} from "./validators/validators.js";

// Errors + types
export * from "./errors.js";
export {
  ChainDirection,
  ChainRole,
  DeviceRole,
  ChainStatus,
  RootKeyStatus,
  KeyHierarchyEventType as KHEventType,
  KeyHierarchyFailureReason,
  KH_KDF,
  KH_KEY_BYTES,
  KH_NAMESPACE,
  KH_VERSION,
  INITIAL_GENERATION,
  INITIAL_INDEX,
  KH_SCHEMA_VERSION,
} from "./types/types.js";

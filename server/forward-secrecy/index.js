/**
 * @module forward-secrecy
 *
 * Public entry point of the **Forward Secrecy Engine** — Layer 5, Sprint 2. Secure
 * sessions no longer use static keys: every session evolution derives fresh cryptographic
 * material from a one-way KDF chain and securely destroys the obsolete secrets, so
 * compromising the current device state cannot recover PAST session keys.
 *
 * ## What this sprint adds
 * - a one-way **generation-secret chain** ({@link module:forward-secrecy/derivation});
 * - **key evolution** + **secure destruction** of superseded material;
 * - **rollback / replay** prevention and generation validation;
 * - **policy-driven** evolution (Sprint 1 policies now advance real generations);
 * - **Secure Transport integration** (encrypt under the latest generation);
 * - repositories, an audit trail, and events.
 *
 * ## Out of scope (later sprints)
 * NO Double Ratchet, NO Chain Keys, NO per-Message Keys, NO Post-Compromise Security, NO
 * P2P/WebRTC. This engine evolves *session generations* only; future sprints derive
 * chain/message keys FROM this evolving state.
 *
 * @example Device
 * ```js
 * import { ForwardSecrecyManager, ForwardSecrecyKeyStore, createInMemoryForwardSecrecyRepository } from "./forward-secrecy/index.js";
 * const fs = new ForwardSecrecyManager({ ...createInMemoryForwardSecrecyRepository(), keyStore: new ForwardSecrecyKeyStore() });
 * await fs.start({ sessionId, handshakeId, participants: ["alice","bob"], rootSecret });
 * await fs.evolve(sessionId, { reason: "rotation" });        // fresh keys; previous destroyed
 * ```
 */

// Manager + key store + repositories
export { ForwardSecrecyManager } from "./manager/forwardSecrecyManager.js";
export { ForwardSecrecyKeyStore } from "./keystore/forwardSecrecyKeyStore.js";
export { createInMemoryForwardSecrecyRepository } from "./repository/inMemoryForwardSecrecyRepository.js";
export { createMongoForwardSecrecyRepository } from "./repository/mongoForwardSecrecyRepository.js";

// Policy execution + transport integration
export { EvolutionPolicyExecutor } from "./policies/policyExecutor.js";
export {
  encryptWithForwardSecrecy,
  decryptWithForwardSecrecy,
  createForwardSecrecyKeyProvider,
  createForwardSecrecyInterceptor,
} from "./transport/transportIntegration.js";

// Derivation (chain) + destruction
export { seedChain, evolveChain, deriveGenerationKeys, disposeChainSecret, chainSalt } from "./derivation/keyChain.js";
export {
  zeroize,
  buildDestructionRecord,
  destroyGenerationKeys,
  destroyChainSecret,
  destroyIntermediateMaterial,
  DestructionReason,
} from "./destruction/secureDestruction.js";

// Lifecycle + validation
export {
  ALLOWED_GENERATION_TRANSITIONS,
  canGenerationTransition,
  assertGenerationTransition,
  assertForwardOnly,
} from "./lifecycle/generationLifecycle.js";
export {
  validateSessionRef,
  requireState,
  validateEvolutionRequest,
  assertGenerationOrdering,
  assertSessionOwnership,
  assertSessionState,
  assertVersionConsistency,
  assertNotDestroyed,
  assertNoReplay,
  validateRepository,
} from "./validation/validators.js";

// Serialization + audit + events
export { toPublicForwardSecrecy, toForwardSecrecyStatus, toPublicGeneration } from "./serialization/serializer.js";
export { auditEntry, appendAudit, assertNoSecretMaterial, AuditAction } from "./audit/audit.js";
export { ForwardSecrecyEventBus, ForwardSecrecyEventType } from "./events/events.js";

// Errors + types
export * from "./errors.js";
export {
  GenerationStatus,
  ALL_GENERATION_STATUSES,
  LIVE_GENERATION_STATUSES,
  ForwardSecrecyEventType as FSEventType,
  DestructionReason as FSDestructionReason,
  EvolutionTrigger,
  ForwardSecrecyFailureReason,
  FS_KDF,
  CHAIN_SECRET_BYTES,
  FS_CIPHER_ALGORITHM,
  FS_MAC_ALGORITHM,
  FS_NAMESPACE,
  FS_CHAIN_VERSION,
  INITIAL_GENERATION,
  DEFAULT_RETAINED_GENERATIONS,
  FS_SCHEMA_VERSION,
} from "./types/types.js";

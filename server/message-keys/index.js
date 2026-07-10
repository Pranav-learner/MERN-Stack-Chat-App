/**
 * @module message-keys
 *
 * Public entry point of the **Per-Message Key** subsystem — Layer 5, Sprint 5. Every message
 * is now encrypted with its own unique cryptographic key, deterministically derived from the
 * active sending/receiving chain (Sprint 4 key hierarchy) and **securely destroyed
 * immediately after use**. Compromise of one message key does not expose any other message.
 *
 * ## What this sprint adds
 * - deterministic **per-message key derivation** from a chain key;
 * - a **Message Key Manager** with the full ephemeral lifecycle (derive → use → destroy →
 *   advance chain);
 * - out-of-order receipt via a bounded **skipped-key cache**;
 * - a complete **Secure Transport** encrypt/decrypt pipeline, repositories, audit, and events.
 *
 * ## Out of scope (Sprint 6+)
 * NO Double Ratchet, NO Post-Compromise Security. This sprint derives per-message keys from
 * the EXISTING chains; the DH ratchet is future work.
 *
 * @example Device
 * ```js
 * import { MessageKeyManager, MessageKeyCache, createInMemoryMessageKeyRepository, createMessageKeyTransport } from "./message-keys/index.js";
 * const mk = new MessageKeyManager({ ...createInMemoryMessageKeyRepository(), chainManager, cache: new MessageKeyCache() });
 * const transport = createMessageKeyTransport({ messageKeyManager: mk });
 * const envelope = await transport.encrypt({ text: "hi" }, { sessionId });
 * const message  = await transport.decrypt(envelope, { sessionId }); // on the peer
 * ```
 */

// Manager + cache + repositories
export { MessageKeyManager, newMessageId } from "./manager/messageKeyManager.js";
export { MessageKeyCache } from "./cache/messageKeyCache.js";
export { createInMemoryMessageKeyRepository } from "./repository/inMemoryMessageKeyRepository.js";
export { createMongoMessageKeyRepository } from "./repository/mongoMessageKeyRepository.js";

// Transport integration
export { encryptMessage, decryptMessage, createMessageKeyTransport } from "./transport/transportIntegration.js";

// Derivation + destruction + lifecycle
export { deriveMessageKey, messageSalt } from "./derivation/derivation.js";
export { destroyMessageKey, zeroize } from "./destruction/destruction.js";
export {
  ALLOWED_MESSAGE_KEY_TRANSITIONS,
  canTransition,
  assertTransition,
  isTerminal,
  MessageKeyState,
} from "./lifecycle/lifecycle.js";

// Metadata + audit + events + serialization + validators
export { createMessageMeta, createSecurityMetadata, createGenerationMetadata, recomputeMetadata } from "./metadata/metadata.js";
export { auditEntry, appendAudit, assertNoSecretMaterial, AuditAction } from "./audit/audit.js";
export { MessageKeyEventBus, MessageKeyEventType } from "./events/events.js";
export { toPublicMessageKeyState, toMessageKeyStatus, toPublicMessageMeta } from "./serialization/serializer.js";
export {
  validateSessionRef,
  requireState,
  validateMessageNumber,
  validateGeneration,
  assertGenerationMatch,
  assertNoDuplicateSend,
  assertNotConsumed,
  validateEnvelope,
  validateRepository,
} from "./validators/validators.js";

// Errors + types
export * from "./errors.js";
export {
  MessageDirection,
  DeliveryStatus,
  MessageKeyEventType as MKEventType,
  MessageKeyFailureReason,
  MK_KDF,
  MK_KEY_BYTES,
  MK_NAMESPACE,
  MK_VERSION,
  DEFAULT_MAX_SKIP,
  DEFAULT_CACHE_LIMIT,
  MK_ENVELOPE_VERSION,
  MK_SCHEMA_VERSION,
} from "./types/types.js";

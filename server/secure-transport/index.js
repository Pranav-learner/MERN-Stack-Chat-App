/**
 * @module secure-transport
 *
 * Public entry point of the **Secure Transport Layer** — Layer 4, Sprint 6: first
 * end-to-end encrypted communication. This layer owns ALL secure communication between
 * devices — encryption, decryption, serialization, secure-payload construction, session
 * usage, and transport abstraction. The application never encrypts directly:
 *
 * ```
 * Application → Secure Transport Layer → Transport → Receiver
 * ```
 *
 * ## Out of scope (Layer 5)
 * NO forward secrecy, NO double ratchet, NO session ratcheting, NO key rotation, NO
 * P2P/WebRTC/NAT, NO offline sync. Encryption uses the EXISTING Sprint 3 session keys.
 *
 * @example Device (encrypt + decrypt)
 * ```js
 * import { SecureTransportManager } from "./secure-transport/index.js";
 * const transport = new SecureTransportManager({ keyProvider: (id) => secureSessionManager.loadSessionKeys(id) });
 * const { serialized } = await transport.encrypt({ text: "hi" }, { sessionId, senderDevice, receiverDevice });
 * const message = await transport.decrypt(serialized); // on the receiver
 * ```
 *
 * @example Server (relay — never decrypts)
 * ```js
 * const relay = new SecureTransportManager(); // no keyProvider
 * const { payload, meta } = relay.relay(req.body.securePayload, { sessionId });
 * ```
 */

// Manager + interceptor bridge
export { SecureTransportManager, TransportMetric } from "./manager/secureTransportManager.js";
export { createSecureTransportInterceptor } from "./interceptor/secureTransportInterceptor.js";

// Encrypt / decrypt / serialize
export { encryptMessage, assertKeys } from "./encryptor/encryptor.js";
export { decryptMessage, tryDecryptMessage } from "./decryptor/decryptor.js";
export { serialize, deserialize, serializeCompact, deserializeCompact, MAX_PAYLOAD_BYTES } from "./serializer/serializer.js";

// Payload + metadata
export {
  assembleSecurePayload,
  decodeSecurePayload,
  metadataOf,
  isSecurePayload,
  assertSecurePayloadShape,
} from "./payload/securePayload.js";
export { buildMetadata, canonicalAAD, validateMetadata, replayKey } from "./metadata/metadata.js";

// Validation
export {
  validateVersion,
  validateForRelay,
  checkReplay,
  looksLikePlaintext,
  SUPPORTED_ENVELOPE_VERSIONS,
} from "./validators/validators.js";

// Transport abstraction + adapters
export { BaseTransport, InMemoryTransport } from "./transport/transport.js";
export { createRestTransport, createSocketTransport } from "./adapters/transportAdapters.js";

// Repository (ciphertext-only storage)
export {
  toStoredCiphertext,
  fromStoredCiphertext,
  createInMemoryCiphertextRepository,
} from "./repositories/ciphertextRepository.js";

// Middleware
export { createSecureTransportMiddleware } from "./middleware/secureTransportMiddleware.js";

// Events
export { SecureTransportEventBus, SecureTransportEventType } from "./events/events.js";

// Errors + types
export * from "./errors.js";
export {
  CIPHER_ALGORITHM,
  MAC_ALGORITHM,
  PAYLOAD_ENVELOPE_VERSION,
  PAYLOAD_VERSION,
  MessageType,
  OperationalType,
  TransportFailureReason,
} from "./types.js";

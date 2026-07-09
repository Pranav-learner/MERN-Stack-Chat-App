/**
 * @packageDocumentation
 *
 * # @securechat/crypto-engine — Cryptographic Engine (Layer 2, Sprint 3)
 *
 * The reusable, feature-complete cryptographic engine, built entirely on
 * `@securechat/crypto-sdk` (Sprint 1). It provides ergonomic, generic engines and
 * payload models that future layers consume instead of low-level crypto calls:
 *
 * - **Symmetric engine** — AES-256-GCM AEAD + chunked/streaming primitives.
 * - **Asymmetric engine** — X25519 key agreement with small-order-point rejection,
 *   fingerprints, and constant-time comparison.
 * - **Signature engine** — Ed25519 sign/verify, attached & detached signed payloads.
 * - **Key derivation** — MasterKey + KeyDerivation with context/purpose separation.
 * - **Payload models** — EncryptedBuffer, SignedPayload, EncryptedFile/Attachment.
 * - **File encryption** — chunk-based, streaming, authenticated (reorder/truncation-safe).
 * - **Integrity** — checksums + non-throwing structured verification.
 * - **Benchmarks** — latency/throughput/memory harness.
 * - **Security utilities** — SecureBuffer, randomness sanity checks, binary validation.
 *
 * It contains NO chat, transport, auth, storage, or protocol logic.
 *
 * @example
 * ```ts
 * import { SymmetricEngine, FileEncryptor, SignatureEngine, KeyDerivation } from "@securechat/crypto-engine";
 * import { generateSigningKeyPair } from "@securechat/crypto-sdk";
 *
 * const kd = KeyDerivation.random();
 * const key = kd.deriveSessionKey("peer-42");
 * const payload = new SymmetricEngine(key).encrypt("hello");
 *
 * const enc = new FileEncryptor().encryptBuffer(new Uint8Array([1,2,3]), key);
 *
 * const kp = generateSigningKeyPair();
 * const signed = new SignatureEngine().signPayload(kp.privateKey, "contract");
 * ```
 */

// Errors
export * from "./errors/index.js";
// Types
export * from "./types/index.js";
// Security utilities
export * from "./security/index.js";
// Key derivation
export {
  MasterKey,
  KeyDerivation,
  DEFAULT_NAMESPACE,
  buildInfoLabel,
  deriveSessionKey,
} from "./kdf/index.js";
// Payload models
export {
  EncryptedBuffer,
  SignedPayload,
  EncryptedFile,
  EncryptedAttachment,
  PAYLOAD_VERSION,
  type EncryptedBufferJSON,
  type SignedPayloadJSON,
  type EncryptedFileJSON,
  type SignatureMetadata,
} from "./payloads/index.js";
// Symmetric engine + streaming primitives
export {
  SymmetricEngine,
  encryptData,
  decryptData,
  DEFAULT_CHUNK_SIZE,
  STREAM_FORMAT_VERSION,
  deriveStreamKey,
  generateStreamSalt,
  sealChunk,
  openChunk,
  chunkNonce,
  rechunk,
  type EncryptToBufferOptions,
} from "./symmetric/index.js";
// Asymmetric engine
export {
  AsymmetricEngine,
  fingerprint,
  fingerprintSegments,
  isX25519SmallOrderPoint,
  type FingerprintOptions,
} from "./asymmetric/index.js";
// Signature engine
export { SignatureEngine, type SignatureEngineOptions } from "./signatures/index.js";
// File encryption
export { FileEncryptor, type FileEncryptOptions } from "./file/index.js";
// Integrity
export {
  IntegrityVerifier,
  computeChecksum,
  verifyChecksum,
  assertChecksum,
} from "./integrity/index.js";
// Benchmarks
export {
  benchmark,
  benchmarkSync,
  sampleMemory,
  benchmarkEncryption,
  benchmarkDecryption,
  benchmarkSigning,
  benchmarkVerification,
  type BenchmarkOptions,
} from "./benchmark/index.js";

// Namespaced access
export * as security from "./security/index.js";
export * as kdf from "./kdf/index.js";
export * as payloads from "./payloads/index.js";
export * as symmetric from "./symmetric/index.js";
export * as asymmetric from "./asymmetric/index.js";
export * as signatures from "./signatures/index.js";
export * as file from "./file/index.js";
export * as integrity from "./integrity/index.js";
export * as bench from "./benchmark/index.js";

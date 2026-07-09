/**
 * @module keys
 *
 * Chat-agnostic key and payload value objects used throughout the SDK:
 *
 * - {@link SymmetricKey}  — 256-bit AES-GCM key.
 * - {@link PublicKey} / {@link PrivateKey} / {@link KeyPair} — X25519 & Ed25519 keys.
 * - {@link SharedSecret} — ECDH output with HKDF-based key derivation.
 * - {@link Signature} — opaque signature value.
 * - {@link CipherText} / {@link EncryptedPayload} — AEAD output containers.
 *
 * None of these know anything about messages, users, sessions, or transport.
 */

export { SymmetricKey } from "./symmetric-key.js";
export { PublicKey, PrivateKey, KeyPair } from "./asymmetric-keys.js";
export { SharedSecret, type DeriveOptions } from "./shared-secret.js";
export { Signature } from "./signature.js";
export {
  CipherText,
  EncryptedPayload,
  type EncryptedPayloadJSON,
  type EncryptedPayloadFields,
} from "./encrypted-payload.js";

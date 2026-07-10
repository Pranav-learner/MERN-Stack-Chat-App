/**
 * @module shs/key-agreement/types
 *
 * Enums and type declarations for the Secure Key Agreement subsystem (Layer 4,
 * Sprint 2). Extends the Sprint 1 Secure Handshake System with **cryptographic key
 * agreement**: two verified devices each generate a fresh ephemeral X25519 key pair,
 * exchange only their PUBLIC ephemeral keys, and INDEPENDENTLY derive an identical
 * shared secret that is never transmitted.
 *
 * @security This sprint establishes a **shared secret** only. It does NOT derive
 * session/message encryption keys, and it does NOT encrypt anything. Private
 * ephemeral keys and the shared secret are device-local; the network and server
 * see PUBLIC ephemeral keys + one-way commitments only.
 */

/**
 * Supported key-agreement algorithms. Sprint 2 ships X25519 (the Layer 2 SDK's
 * key-agreement primitive). New algorithms are added here WITHOUT reshaping the
 * module — negotiation and validation pick them up.
 * @readonly @enum {string}
 */
export const KeyAgreementAlgorithm = Object.freeze({
  X25519: "x25519",
});

/** All supported algorithms, most-preferred first (used by negotiation). */
export const SUPPORTED_ALGORITHMS = Object.freeze([KeyAgreementAlgorithm.X25519]);

/** Raw X25519 public-key length, in bytes. */
export const X25519_PUBLIC_KEY_BYTES = 32;

/** X25519 shared-secret length, in bytes. */
export const X25519_SHARED_SECRET_BYTES = 32;

/**
 * The crypto protocol version negotiated independently of the SHS handshake
 * version (so key-agreement can evolve on its own cadence).
 */
export const CRYPTO_PROTOCOL_VERSION = "1.0";
export const MIN_CRYPTO_PROTOCOL_VERSION = "1.0";
export const SUPPORTED_CRYPTO_VERSIONS = Object.freeze(["1.0"]);

/**
 * The party's role in the key agreement (mirrors the handshake role).
 * @readonly @enum {string}
 */
export const KeyAgreementRole = Object.freeze({
  INITIATOR: "initiator",
  RESPONDER: "responder",
});

/** The other role. @param {string} role @returns {string} */
export function peerRole(role) {
  return role === KeyAgreementRole.INITIATOR ? KeyAgreementRole.RESPONDER : KeyAgreementRole.INITIATOR;
}

/**
 * Lifecycle of a key-exchange record (the PUBLIC coordination state the server
 * relays). Distinct from the SHS session state — it tracks how far the public-key
 * exchange has progressed.
 * @readonly @enum {string}
 */
export const ExchangeState = Object.freeze({
  NEGOTIATED: "negotiated", // algorithm + version agreed
  AWAITING_INITIATOR_KEY: "awaiting_initiator_key",
  AWAITING_RESPONDER_KEY: "awaiting_responder_key",
  KEYS_EXCHANGED: "keys_exchanged", // both public ephemeral keys present
  ESTABLISHED: "established", // both commitments present + equal
  FAILED: "failed",
});

/**
 * Key-agreement event types. Future layers (session-key derivation, messaging)
 * subscribe to these.
 * @readonly @enum {string}
 */
export const KeyAgreementEventType = Object.freeze({
  NEGOTIATION_SUCCEEDED: "keyagreement.negotiation_succeeded",
  NEGOTIATION_FAILED: "keyagreement.negotiation_failed",
  EPHEMERAL_KEY_GENERATED: "keyagreement.ephemeral_key_generated",
  PEER_KEY_RECEIVED: "keyagreement.peer_key_received",
  SHARED_SECRET_DERIVED: "keyagreement.shared_secret_derived",
  SESSION_MATERIAL_CREATED: "keyagreement.session_material_created",
  KEY_AGREEMENT_COMPLETED: "keyagreement.completed",
  KEY_AGREEMENT_FAILED: "keyagreement.failed",
  EPHEMERAL_KEYS_DESTROYED: "keyagreement.ephemeral_keys_destroyed",
});

/**
 * Machine-readable reasons for a failed key agreement.
 * @readonly @enum {string}
 */
export const KeyAgreementFailureReason = Object.freeze({
  UNKNOWN_PEER: "unknown-peer",
  INVALID_PUBLIC_KEY: "invalid-public-key",
  SMALL_ORDER_POINT: "small-order-point",
  ALL_ZERO_SECRET: "all-zero-secret",
  ALGORITHM_MISMATCH: "algorithm-mismatch",
  VERSION_MISMATCH: "version-mismatch",
  SECRET_MISMATCH: "secret-mismatch",
  MALFORMED_PAYLOAD: "malformed-payload",
  REPLAY: "replay",
  EXPIRED: "expired",
  DUPLICATE: "duplicate",
  PEER_AUTH_FAILED: "peer-authentication-failed",
  INTERNAL_ERROR: "internal-error",
});

/**
 * @typedef {object} EphemeralPublicKeyBundle
 * @property {string} algorithm one of {@link KeyAgreementAlgorithm}
 * @property {string} publicKey base64 raw 32-byte X25519 public key (PUBLIC)
 * @property {string} keyId a random id for this ephemeral key (traceability)
 * @property {number} version ephemeral key format version
 * @property {string} [signature] optional Ed25519 signature over `publicKey` by the
 *   party's identity key (authenticated key exchange)
 * @property {string} [identityPublicKey] the identity public key that signed (base64)
 * @property {string} createdAt ISO
 */

/**
 * @typedef {object} KeyExchangeRecord PUBLIC coordination record (server-relayed).
 * @property {string} handshakeId
 * @property {string} initiator @property {string} responder user ids
 * @property {string} algorithm @property {string} cryptoVersion
 * @property {EphemeralPublicKeyBundle} [initiatorKey]
 * @property {EphemeralPublicKeyBundle} [responderKey]
 * @property {string} [initiatorCommitment] one-way hash of the initiator's derived secret
 * @property {string} [responderCommitment] one-way hash of the responder's derived secret
 * @property {ExchangeState} state
 * @property {object} metadata
 * @property {string} createdAt @property {string} updatedAt @property {string} expiresAt
 */

/**
 * @typedef {object} SessionMaterial DEVICE-LOCAL secure material. `sharedSecret` is
 * NEVER serialized to a DTO or sent over the network.
 * @property {string} sessionId
 * @property {string} handshakeId
 * @property {string} sharedSecret base64 raw shared secret — SECRET, local only
 * @property {string} sharedSecretFingerprint SHA-256 commitment (safe to expose)
 * @property {string} algorithm @property {string} cryptoVersion
 * @property {{ keyLength: number, kdf: string, ephemeralDestroyed: boolean }} security
 * @property {object} metadata
 * @property {string} createdAt @property {string} expiresAt
 */
